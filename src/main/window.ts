import { BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { is } from '@electron-toolkit/utils'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Fenêtre principale : contextIsolation strict, sandbox renderer.
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#000000',
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#ffffff',
      height: 48
    },
    autoHideMenuBar: true,
    webPreferences: {
      // `index.js` car le preload est compilé en CommonJS (voir electron.vite.config.ts).
      // Requis par `sandbox: true` qui refuse les modules ESM.
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  // Maximize + show dans le même callback `ready-to-show` : évite le
  // flash blanc du chargement ET ouvre directement à la taille max de
  // l'écran (moins la barre de tâches Windows). Les `width/height` ci-
  // dessus servent de taille fallback si la restauration échoue — sinon
  // l'utilisateur verrait brièvement la petite fenêtre 1440×900 avant
  // le maximize. Ici, `maximize()` est appelé AVANT `show()` donc l'user
  // voit directement la fenêtre plein écran.
  win.on('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  // Liens externes → navigateur système, jamais dans la fenêtre Electron.
  //
  // Deux chemins de navigation distincts, tous les deux à capturer :
  //
  // 1. `setWindowOpenHandler` : déclenché par `window.open(...)` ou un
  //    `<a target="_blank">`. Couvre la plupart des clics sur des liens
  //    dans une iframe VSCode / un dropdown, etc.
  //
  // 2. `will-navigate` : déclenché par un clic direct sur `<a href="…">`
  //    SANS target (comportement navigateur par défaut) qui navigue la
  //    frame TOP du renderer vers la nouvelle URL, ÉCRASANT l'application
  //    BlowWorks. C'est exactement le bug qu'un lien markdown d'une
  //    réponse IA peut provoquer : un clic envoie tout le renderer hors
  //    de notre SPA sans possibilité de retour arrière (pas de toolbar
  //    navigateur, frame=true mais pas de contrôles).
  //
  //    On `preventDefault()` et on délègue au navigateur système. On
  //    ne filtre QUE les URLs http(s) pour ne pas casser les nav internes
  //    éventuelles (file://, blob:, data: en dev/HMR Vite).
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL()
    // Laisse passer les navigations internes Vite (HMR) et le chargement
    // initial (file:// en prod, http://localhost:5173 en dev).
    if (url === currentUrl) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        // Cible un domaine externe (les 127.0.0.1:* VSCode sont chargés
        // en iframe, pas en top-frame → ne déclenchent pas `will-navigate`).
        event.preventDefault()
        shell.openExternal(url)
      }
    } catch {
      /* URL illisible → on laisse Chromium gérer (échouera proprement) */
    }
  })

  // Chargement du renderer : URL Vite en dev, fichier HTML en prod.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
