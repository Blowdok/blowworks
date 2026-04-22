import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createMainWindow } from './window.js'
import { registerProjectHandlers } from './ipc/project.js'
import { registerTerminalHandlers } from './ipc/terminal.js'
import { registerVSCodeHandlers } from './ipc/vscode.js'
import { registerCanvasHandlers } from './ipc/canvas.js'
import { registerSettingsHandlers } from './ipc/settings.js'
import { registerDialogHandlers } from './ipc/dialog.js'
import { registerGitHubHandlers } from './ipc/github.js'
import { registerAIHandlers } from './ipc/ai.js'
import { initDatabase } from './services/db.js'
import { ptyManager } from './services/pty-manager.js'
import { vscodeServer } from './services/vscode-server.js'

// Point d'entrée du process principal Electron.

// Force `navigator.language === 'en-US'` dans tout le renderer Electron —
// DOIT être appelé AVANT `app.whenReady()` pour prendre effet. Sans ça, le
// workbench VSCode embarqué dans l'iframe hérite de `fr-FR` (Windows système
// francophone), tombe en fallback sur un pack de langue français incomplet,
// et crash avec `Uncaught Error: !!! NLS MISSING: 17282 !!!` au chargement.
// Le workbench VSCode lit UNIQUEMENT `navigator.language` côté client (ni
// query param `?locale=`, ni header `Accept-Language` ne sont consultés) —
// ce switch est donc l'unique levier côté Electron. tldraw reste forcé en
// français via `editor.user.updateUserPreferences({ locale: 'fr' })` au
// mount (cf. InfiniteCanvas.tsx).
app.commandLine.appendSwitch('lang', 'en-US')

// Désactive le Third-Party Storage Partitioning de Chromium 115+ :
//   Renderer top     = localhost:5173 (dev) / file:// (prod)
//   Iframe VSCode    = http://127.0.0.1:27338 → cross-origin
// Sans ce switch, localStorage / IndexedDB / cookies de l'iframe VSCode sont
// partitionnés par couple (top-origin, iframe-origin). Résultat concret :
// chaque shape VSCode du canvas reçoit un bucket de storage séparé → le
// `SecretStorage` d'authentification (GitHub, Copilot) n'est JAMAIS partagé
// entre les shapes. L'utilisateur doit se ré-authentifier à chaque nouvelle
// shape. Désactiver le partitioning rend le storage unifié par origin,
// comportement historique. Acceptable ici : une seule origine tierce
// (127.0.0.1:27338) sous notre contrôle total.
app.commandLine.appendSwitch(
  'disable-features',
  'ThirdPartyStoragePartitioning,PartitionedCookies'
)

app.whenReady().then(async () => {
  // Préférences Windows standard (AppUserModelId pour taskbar).
  electronApp.setAppUserModelId('com.blowdok.blowworks')

  // Raccourcis DevTools en développement uniquement.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialisation base SQLite (migrations incluses).
  initDatabase()

  // Enregistrement des handlers IPC typés.
  registerProjectHandlers()
  registerTerminalHandlers()
  registerVSCodeHandlers()
  registerCanvasHandlers()
  registerSettingsHandlers()
  registerDialogHandlers()
  registerGitHubHandlers()
  registerAIHandlers()

  // Démarrage du sidecar openvscode-server en tâche de fond (non bloquant).
  // Démarrage paresseux déclenché à la première demande VSCode.
  if (!is.dev) {
    vscodeServer.ensureStarted().catch((err) => {
      console.error('[vscode-server] démarrage différé impossible', err)
    })
  }

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

// Sortie propre : tuer PTY + sidecar VSCode.
app.on('before-quit', async () => {
  await ptyManager.disposeAll()
  await vscodeServer.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
