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
import { registerWikiHandlers } from './ipc/wiki.js'
import { registerAgentsHandlers } from './ipc/agents.js'
import { registerBrowserHandlers } from './ipc/browser.js'
import { registerFsExplorerHandlers } from './ipc/fs-explorer.js'
import { attachDownloadHandlers } from './services/browser-downloads.js'
import { loadExtensionsAtBoot } from './services/browser-extensions.js'
import { initDatabase } from './services/db.js'
import { ptyManager } from './services/pty-manager.js'
import { vscodeServer } from './services/vscode-server.js'
import { initAutoUpdater } from './services/update-manager.js'
import { startRendererServer, stopRendererServer } from './renderer-server.js'

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

// Port loopback fixe du serveur http qui sert le renderer compilé en production.
const RENDERER_PORT = 27339

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
  registerWikiHandlers()
  registerAgentsHandlers()
  registerBrowserHandlers()
  registerFsExplorerHandlers()

  // Capture les téléchargements de la partition `persist:browser` (utilisée
  // par tous les <webview> des BrowserShape). DOIT être attaché APRÈS
  // app.whenReady() et AVANT que les webviews n'aient déclenché leur
  // premier will-download — pratiquement, attacher juste après les
  // handlers IPC suffit largement (les shapes prennent quelques secondes
  // à apparaître au boot).
  attachDownloadHandlers()

  // Charge les extensions Chrome présentes dans userData/extensions/
  // dans la session `persist:browser`. Non bloquant — si une extension
  // échoue, on log et on continue (les autres se chargent quand même).
  loadExtensionsAtBoot().catch((err) => {
    console.warn('[main] Chargement extensions boot a renvoyé une erreur', err)
  })

  // Démarrage du sidecar openvscode-server en tâche de fond (non bloquant).
  // Démarrage paresseux déclenché à la première demande VSCode.
  if (!is.dev) {
    vscodeServer.ensureStarted().catch((err) => {
      console.error('[vscode-server] démarrage différé impossible', err)
    })
  }

  // URL du renderer : serveur Vite en dev, sinon serveur http local statique
  // (production et exécutions non empaquetées). Le serveur http garantit que
  // les assets tldraw se chargent comme en dev (résolution d'URL + fetch http).
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const rendererUrl = devUrl ?? (await startRendererServer(RENDERER_PORT))
  const isDevServer = Boolean(devUrl)

  createMainWindow(rendererUrl, isDevServer)

  // Vérifie et propose les mises à jour automatiques (production uniquement).
  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(rendererUrl, isDevServer)
    }
  })
})

// Sortie propre : tuer PTY + sidecar VSCode.
app.on('before-quit', async () => {
  stopRendererServer()
  await ptyManager.disposeAll()
  await vscodeServer.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
