import { BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Fenêtre principale : contextIsolation strict, sandbox renderer.
export function createMainWindow(loadUrl: string, isDevServer: boolean): BrowserWindow {
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
  // `sourceWebContentsId` (optionnel) : id du webContents qui a émis le
  // lien — sert au renderer à distinguer un lien venant d'une BrowserShape
  // (à ajouter en onglet) d'un lien venant d'ailleurs (Chat / Terminal /
  // VSCode → spawne une nouvelle shape).
  const routeToInternalBrowser = (url: string, sourceWebContentsId?: number): void => {
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
    win.webContents.send(IPC_CHANNELS.browser.openUrlEvent, {
      url,
      sourceWebContentsId
    })
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
  // les `window.open(...)` selon leur disposition :
  //
  //   - `disposition === 'new-window'` : popup type OAuth (claude.ai
  //     "Continuer avec Google", GitHub login, etc.). On AUTORISE une
  //     vraie BrowserWindow fille qui partage la partition `persist:browser`
  //     du webview parent (cookies/session communs) ET garde la relation
  //     `window.opener` intacte côté renderer — sans ça, la popup OAuth
  //     ne peut pas appeler `window.opener.postMessage(...)` ni
  //     `window.close()` après avoir reçu le callback, et tourne en boucle.
  //
  //   - autres dispositions (`foreground-tab`, `background-tab`, `default`,
  //     etc.) : c'est un clic `<a target="_blank">` ou middle-click → on
  //     veut garder le lien dans BlowWorks, donc nouvelle BrowserShape.
  //
  // `did-attach-webview` est aussi le bon endroit pour brancher d'autres
  // listeners par-webview à l'avenir (cf. `will-navigate`, `permission-request`).
  win.webContents.on('did-attach-webview', (_event, wc) => {
    wc.setWindowOpenHandler((details) => {
      if (details.disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            parent: win,
            modal: false,
            autoHideMenuBar: true,
            backgroundColor: '#000000',
            webPreferences: {
              // CRUCIAL : même partition que le webview parent pour que
              // les cookies de session (claude.ai, accounts.google.com,
              // etc.) soient partagés entre la shape et la popup OAuth.
              partition: 'persist:browser',
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true
            }
          }
        }
      }
      // wc.id = webContents source (le webview lui-même). Le renderer
      // l'utilise pour router le lien vers le bon onglet de la bonne shape.
      routeToInternalBrowser(details.url, wc.id)
      return { action: 'deny' }
    })
  })

  // Chargement du renderer via l'URL fournie : serveur Vite en dev, serveur
  // http local statique en production.
  win.loadURL(loadUrl)

  // En dev uniquement : le serveur Vite peut n'être pas encore prêt au démarrage
  // d'Electron (ERR_CONNECTION_REFUSED, code -102). On retry le chargement
  // toutes les 500 ms pendant ~10 s. En prod, le serveur http local écoute déjà
  // avant cet appel — aucun retry nécessaire.
  if (isDevServer) {
    let retries = 0
    const MAX_RETRIES = 20
    const onFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      _errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) return
      if (errorCode !== -102) return
      if (validatedURL !== loadUrl && !validatedURL.startsWith(loadUrl)) return
      if (retries >= MAX_RETRIES) {
        console.warn(`[main] Vite indisponible après ${MAX_RETRIES} tentatives — abandon`)
        return
      }
      retries++
      setTimeout(() => {
        if (!win.isDestroyed()) win.loadURL(loadUrl)
      }, 500)
    }
    win.webContents.on('did-fail-load', onFailLoad)
    win.webContents.once('did-finish-load', () => {
      win.webContents.off('did-fail-load', onFailLoad)
    })
  }

  return win
}
