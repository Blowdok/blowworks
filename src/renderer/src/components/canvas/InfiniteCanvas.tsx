import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Tldraw, type Editor, createShapeId } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import 'tldraw/tldraw.css'
import {
  customShapeUtils,
  type TerminalShape,
  type VSCodeShape,
  type ChatShape
} from './shapes/index.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useCanvasPersistence } from '../../hooks/use-canvas-persistence.js'
import { useEditorStore } from '../../stores/editor-store.js'
import { useUIStore } from '../../stores/ui-store.js'
import ShapePortalManager from '../shape-portal/ShapePortalManager.js'

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

      // Raccourcis globaux :
      //   Ctrl+T  → nouveau terminal
      //   Ctrl+K  → nouvelle conversation IA
      //   Alt+T   → toggle toolbar tldraw (outils select/hand/draw/…)
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.key.toLowerCase() === 't' && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          spawnTerminalShape(editor)
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'k' && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          void spawnChatShape(editor)
        }
        if (e.altKey && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault()
          toggleToolbar()
        }
      }
      window.addEventListener('keydown', onKeyDown)

      return () => {
        dispose()
        window.removeEventListener('keydown', onKeyDown)
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
    </div>
  )
}

// Crée une nouvelle shape terminal au centre du viewport caméra.
// Exporté pour être invocable depuis le Header (bouton "+ Nouveau terminal").
export function spawnTerminalShape(editor: Editor): void {
  const bounds = editor.getViewportPageBounds()
  const cx = bounds.midX
  const cy = bounds.midY
  editor.createShape<TerminalShape>({
    id: createShapeId(),
    type: 'terminal',
    x: cx - 320,
    y: cy - 190,
    props: {
      w: 640,
      h: 380,
      shell: 'powershell',
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
export async function spawnChatShape(editor: Editor): Promise<void> {
  const bounds = editor.getViewportPageBounds()
  const cx = bounds.midX
  const cy = bounds.midY
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
      model: defaults.model,
      webSearchEnabled: false,
      thinkingEnabled: false
    }
  })
  editor.setSelectedShapes([id])
}

// Crée une nouvelle shape VSCode liée à un dossier concret. Spawne le
// sidecar openvscode-server au montage si nécessaire (cf. VSCodeShape).
export function spawnVSCodeShape(editor: Editor, folder: string): void {
  const bounds = editor.getViewportPageBounds()
  const cx = bounds.midX
  const cy = bounds.midY
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
