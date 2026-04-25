import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Tldraw, type Editor, createShapeId } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import 'tldraw/tldraw.css'
import {
  customShapeUtils,
  type TerminalShape,
  type VSCodeShape,
  type ChatShape,
  type BrowserShape
} from './shapes/index.js'
import {
  resolveQuery,
  lookupWebContentsBinding,
  addTabToShape
} from './shapes/BrowserShape.js'
import { getSearchEngine } from '@shared/search-engines.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useCanvasPersistence } from '../../hooks/use-canvas-persistence.js'
import { useEditorStore } from '../../stores/editor-store.js'
import { useUIStore } from '../../stores/ui-store.js'
import ShapePortalManager from '../shape-portal/ShapePortalManager.js'
import CanvasContextMenu from './CanvasContextMenu.js'
import CanvasBackground from './CanvasBackground.js'

// Slot tldraw `OnTheCanvas` : rendu DERRIÈRE les shapes mais DANS le
// repère caméra (zoom + pan appliqués). Idéal pour notre image de fond
// centrée à l'origine. Référence stable pour ne pas faire remount le
// slot à chaque rerender de InfiniteCanvas.
const TLDRAW_COMPONENTS = { OnTheCanvas: CanvasBackground } as const

// Canvas infini tldraw + shape utils custom (Terminal, VSCode).
export default function InfiniteCanvas() {
  const editorRef = useRef<Editor | null>(null)
  const { loadInitial, scheduleSave } = useCanvasPersistence()

  const setEditorGlobal = useEditorStore((s) => s.setEditor)
  const stylePanelVisible = useUIStore((s) => s.stylePanelVisible)
  const toolbarVisible = useUIStore((s) => s.toolbarVisible)
  const toggleToolbar = useUIStore((s) => s.toggleToolbar)

  // Bundle local des icônes/polices/traductions tldraw via Vite. Indispensable
  // en Electron : la CSP `default-src 'self'` bloque le CDN par défaut, ce qui
  // empêche toutes les icônes de la toolbar/style panel/minimap de s'afficher.
  const assetUrls = useMemo(() => getAssetUrlsByImport(), [])

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      setEditorGlobal(editor)
      // Force tldraw en français malgré `navigator.language === 'en-US'`
      // (switch Electron global posé côté main pour que l'iframe VSCode ne
      // crashe pas sur `NLS MISSING`). Sans cette override, tldraw basculerait
      // en anglais pour l'ensemble du canvas.
      editor.user.updateUserPreferences({ locale: 'fr' })

      // Filtre les URLs à protocole non-http(s) AVANT création d'un bookmark.
      // Sans ce garde, drag-drop d'un lien exotique (ex: `claude-code://…`)
      // fait appeler `fetch()` par tldraw pour générer le preview bookmark,
      // ce qui viole notre CSP `connect-src 'self' http://127.0.0.1:*
      // https://api.github.com` PUIS déclenche un ValidationError sur
      // `asset.props.src` (protocole invalide) → ErrorBoundary `<Crash>`.
      // On capture le handler default de tldraw (non-public mais stable
      // en runtime) pour déléguer uniquement sur les URLs sûres.
      const editorInternal = editor as unknown as {
        externalContentHandlers: Record<
          string,
          ((info: unknown) => unknown | Promise<unknown>) | undefined
        >
      }
      const defaultUrlHandler = editorInternal.externalContentHandlers['url']
      const isSafeBookmarkUrl = (raw: string): boolean => {
        try {
          const { protocol } = new URL(raw)
          return protocol === 'http:' || protocol === 'https:'
        } catch {
          return false
        }
      }
      editor.registerExternalContentHandler('url', async (info) => {
        if (!isSafeBookmarkUrl(info.url)) {
          console.warn(
            '[canvas] URL ignorée (protocole non supporté pour bookmark) :',
            info.url
          )
          return
        }
        return defaultUrlHandler?.(info as never) as never
      })

      void loadInitial(editor)

      // Sauvegarde débouncée sur toute modification utilisateur.
      const dispose = editor.store.listen(
        () => scheduleSave(editor),
        { source: 'user', scope: 'document' }
      )

      // Raccourcis globaux : spawn à la position COURANTE du pointeur
      // (évite les chevauchements par défaut au centre du viewport).
      // Si le pointeur n'est pas sur le canvas (ex. déclenché depuis
      // un bouton header), on fallback au viewport center.
      //   Ctrl+T  → nouveau terminal
      //   Ctrl+K  → nouvelle conversation IA
      //   Ctrl+B  → nouveau navigateur (DDG)
      //   Alt+T   → toggle toolbar tldraw (outils select/hand/draw/…)
      const getPointerAt = (): { x: number; y: number } | undefined => {
        // `inputs.currentPagePoint` est mis à jour en continu par tldraw
        // à chaque mouvement. On accepte la position si elle est dans le
        // viewport courant — sinon c'est une position stale (focus hors
        // canvas) et on fallback au centre.
        const p = editor.inputs.currentPagePoint
        const bounds = editor.getViewportPageBounds()
        if (!bounds.containsPoint(p)) return undefined
        return { x: p.x, y: p.y }
      }
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.key.toLowerCase() === 't' && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          spawnTerminalShape(editor, getPointerAt())
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'k' && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          void spawnChatShape(editor, getPointerAt())
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'b' && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          spawnBrowserShape(editor, undefined, getPointerAt())
        }
        if (e.altKey && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault()
          toggleToolbar()
        }
      }
      window.addEventListener('keydown', onKeyDown)

      // IPC `browser.openUrl` : déclenché par le main quand un lien est
      // intercepté (setWindowOpenHandler, will-navigate). Deux cas :
      //   - Le lien vient d'un webview de BrowserShape (sourceWebContentsId
      //     enregistré dans le registre côté renderer) → on AJOUTE un
      //     onglet à CETTE shape, au lieu d'en spawner une nouvelle.
      //   - Sinon (Chat, Terminal, VSCode, will-navigate du root, etc.) →
      //     comportement historique : nouvelle BrowserShape sur le canvas.
      const detachOpenUrl = window.blow.browser.onOpenUrl(({ url, sourceWebContentsId }) => {
        if (typeof sourceWebContentsId === 'number') {
          const binding = lookupWebContentsBinding(sourceWebContentsId)
          if (binding) {
            addTabToShape(editor, binding.shapeId, url)
            return
          }
        }
        spawnBrowserShape(editor, url)
      })

      return () => {
        dispose()
        window.removeEventListener('keydown', onKeyDown)
        detachOpenUrl()
        setEditorGlobal(null)
      }
    },
    [loadInitial, scheduleSave, setEditorGlobal, toggleToolbar]
  )

  useEffect(() => {
    return () => {
      editorRef.current = null
    }
  }, [])

  return (
    <div
      className={`absolute inset-0 bg-[var(--bg-primary)] ${
        stylePanelVisible ? '' : 'hide-tldraw-style-panel'
      } ${toolbarVisible ? '' : 'hide-tldraw-toolbar'}`}
    >
      <Tldraw
        persistenceKey="blowworks-canvas"
        shapeUtils={customShapeUtils}
        assetUrls={assetUrls}
        components={TLDRAW_COMPONENTS}
        onMount={handleMount}
        inferDarkMode
      >
        {/*
          Manager rendu EN TANT QU'ENFANT de <Tldraw> pour accéder au
          contexte `useEditor()`. Il maintient en DOM un portail par
          shape lourde (vscode, terminal) de TOUTES les pages — ainsi
          l'iframe VSCode et l'instance xterm survivent aux switch de
          pages tldraw. Voir `ShapePortalManager.tsx`.
        */}
        <ShapePortalManager />
      </Tldraw>
      {/* Menu contextuel custom au clic droit sur le VIDE : crée chat /
          terminal / browser / vscode centrés sur le point cliqué. Sur une
          shape existante, le menu tldraw natif reste actif. */}
      <CanvasContextMenu />
    </div>
  )
}

// Centre de spawn : soit `at` si fourni (clic droit / pointeur souris au
// moment du raccourci), soit le centre géométrique du viewport. Factorisé
// car les 4 spawn l'ont en commun.
function resolveSpawnCenter(
  editor: Editor,
  at?: { x: number; y: number }
): { x: number; y: number } {
  if (at) return at
  const bounds = editor.getViewportPageBounds()
  return { x: bounds.midX, y: bounds.midY }
}

// Crée une nouvelle shape terminal. Par défaut au centre du viewport ;
// si `at` est fourni (clic droit sur canvas ou pointeur au moment d'un
// raccourci), la shape est centrée sur ce point page. Exporté pour être
// invocable depuis le Header (bouton "+ Nouveau terminal").
// Le shell par défaut est celui choisi en dernier par l'utilisateur
// (persisté dans `useUIStore.lastShell`) — évite de rebasculer vers pwsh
// à chaque spawn si l'utilisateur travaille par préférence dans un autre
// shell. `getState()` car la fonction est appelée hors React.
export function spawnTerminalShape(editor: Editor, at?: { x: number; y: number }): void {
  const { x: cx, y: cy } = resolveSpawnCenter(editor, at)
  const shell = useUIStore.getState().lastShell
  editor.createShape<TerminalShape>({
    id: createShapeId(),
    type: 'terminal',
    x: cx - 320,
    y: cy - 190,
    props: {
      w: 640,
      h: 380,
      shell,
      cwd: getDefaultCwd(),
      projectId: null,
      spawned: false
    }
  })
}

function getDefaultCwd(): string {
  // Dossier de travail par défaut : le bureau de l'utilisateur. En v2 :
  // préférence utilisateur configurable.
  return 'C:/Users/Blowdok/Desktop'
}

// Crée une nouvelle ChatShape au centre du viewport + persiste la conversation
// côté DB via l'API main. L'id tldraw est réutilisé comme id de conversation
// SQLite → pas de mapping à maintenir.
//
// Le modèle par défaut est lu depuis `useChatStore.defaults.model` (chargé
// au boot depuis settings SQLite). Si aucune clé OpenRouter n'est encore
// configurée, la shape est quand même créée — l'envoi du premier message
// retournera une erreur explicite qui guidera l'utilisateur vers Settings.
export async function spawnChatShape(
  editor: Editor,
  at?: { x: number; y: number }
): Promise<void> {
  const { x: cx, y: cy } = resolveSpawnCenter(editor, at)
  const id = createShapeId()
  const defaults = useChatStore.getState().defaults

  // Crée d'abord la conversation SQLite (main fait foi), puis la shape.
  // Ordre important : si la création DB échoue, on n'a pas une shape
  // orpheline sur le canvas sans backing store.
  try {
    await window.blow.ai.createConversation({
      id,
      model: defaults.model,
      temperature: defaults.temperature,
      projectId: null
    })
  } catch (e) {
    console.error('[chat] échec création conversation', e)
    return
  }

  editor.createShape<ChatShape>({
    id,
    type: 'chat',
    x: cx - 280,
    y: cy - 240,
    props: {
      w: 560,
      h: 480,
      projectId: null,
      // Bind explicite shape ⇄ conversation initiale. Le bouton « + new »
      // du header fera muter cette prop pour plugger une autre conv sur la
      // même shape (cf. ChatPortalView.handleNewConversation).
      conversationId: id,
      model: defaults.model,
      webSearchEnabled: false,
      thinkingEnabled: false,
      wikiContextEnabled: false
    }
  })
  editor.setSelectedShapes([id])
}

// Crée une nouvelle BrowserShape au centre du viewport. URL par défaut =
// homepage du moteur courant (Settings > Navigateur). Si `rawUrl` est
// fourni (lien intercepté, bouton header avec pré-saisie, etc.), on le
// résout via `resolveQuery` : URL nue / avec schéma / texte de recherche
// sont tous acceptés et utilisent le moteur courant pour les recherches.
export function spawnBrowserShape(
  editor: Editor,
  rawUrl?: string,
  at?: { x: number; y: number }
): void {
  const { x: cx, y: cy } = resolveSpawnCenter(editor, at)
  // `getState()` plutôt qu'un hook : `spawnBrowserShape` n'est pas un
  // composant React, on lit juste un snapshot ponctuel.
  const engine = getSearchEngine(useUIStore.getState().searchEngine)
  const url = rawUrl ? resolveQuery(rawUrl, engine) : engine.homepage
  const id = createShapeId()
  // Initialisation explicite de `tabsJson` + `activeTabId` avec l'URL
  // demandée — `getDefaultProps` retomberait sinon sur FALLBACK_HOMEPAGE
  // et le webview chargerait la mauvaise page initiale.
  const tabId = `t_${Math.random().toString(36).slice(2, 10)}`
  editor.createShape<BrowserShape>({
    id,
    type: 'browser',
    x: cx - 450,
    y: cy - 300,
    props: {
      w: 900,
      h: 600,
      url,
      tabsJson: JSON.stringify([{ id: tabId, url, title: '', favicon: null }]),
      activeTabId: tabId,
      projectId: null
    }
  })
  editor.setSelectedShapes([id])
}

// Crée une nouvelle shape VSCode liée à un dossier concret. Spawne le
// sidecar openvscode-server au montage si nécessaire (cf. VSCodeShape).
export function spawnVSCodeShape(
  editor: Editor,
  folder: string,
  at?: { x: number; y: number }
): void {
  const { x: cx, y: cy } = resolveSpawnCenter(editor, at)
  // Normalise les backslashes Windows en slashes pour l'URL du serveur.
  const normalized = folder.replace(/\\/g, '/')
  editor.createShape<VSCodeShape>({
    id: createShapeId(),
    type: 'vscode',
    x: cx - 480,
    y: cy - 300,
    props: {
      w: 960,
      h: 600,
      folder: normalized,
      projectId: null
    }
  })
}
