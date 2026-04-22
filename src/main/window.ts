import { BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'

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
      // Activé pour la BrowserShape interne (<webview> Electron). Sans ce
      // flag, le tag `<webview>` est totalement inerte — aucun rendu,
      // aucun événement. Sécurité : chaque webview a son propre process
      // isolé de la fenêtre principale, pas d'accès au préchargement
      // principal. On scope les webviews via `partition="persist:browser"`
      // pour garder session/cookies séparés du reste de l'app.
      webviewTag: true,
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

  // Liens externes → routés vers la BrowserShape interne (navigateur
  // intégré). Deux chemins de navigation à capturer :
  //
  // 1. `setWindowOpenHandler` : déclenché par `window.open(...)` ou un
  //    `<a target="_blank">`. Couvre la plupart des clics sur des liens
  //    dans une iframe VSCode / un dropdown, etc.
  //
  // 2. `will-navigate` : déclenché par un clic direct sur `<a href="…">`
  //    SANS target qui navigue la frame TOP du renderer, ÉCRASANT la
  //    SPA BlowWorks.
  //
  // Dans les deux cas on envoie un événement IPC `browser.openUrl` au
  // renderer qui spawne une BrowserShape avec l'URL. Si aucun editor
  // tldraw n'est monté (cas limite au boot), le renderer peut choisir
  // de fallback sur `shell.openExternal` — mais par défaut la promesse
  // reste "navigateur interne".
  const routeToInternalBrowser = (url: string): void => {
    if (win.isDestroyed()) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        // Protocoles non-web (mailto:, file:, custom schemes) → OS.
        shell.openExternal(url)
        return
      }
    } catch {
      return
    }
    win.webContents.send(IPC_CHANNELS.browser.openUrlEvent, { url })
  }

  win.webContents.setWindowOpenHandler((details) => {
    routeToInternalBrowser(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL()
    if (url === currentUrl) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        event.preventDefault()
        routeToInternalBrowser(url)
      }
    } catch {
      /* URL illisible → on laisse Chromium gérer (échouera proprement) */
    }
  })

  // Les shapes <webview> héritent d'un `webContents` propre. On intercepte
  // `will-navigate` sur chaque nouvelle webview pour que les clics à
  // l'intérieur restent dans la même webview (comportement navigateur
  // normal), MAIS les `window.open` depuis une webview (target=_blank)
  // créent une nouvelle BrowserShape au lieu d'une fenêtre Electron.
  win.webContents.on('did-attach-webview', (_event, wc) => {
    wc.setWindowOpenHandler((details) => {
      routeToInternalBrowser(details.url)
      return { action: 'deny' }
    })
  })

  // Chargement du renderer : URL Vite en dev, fichier HTML en prod.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
