import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  createShapePropsMigrationSequence,
  type TLBaseShape,
  type RecordProps
} from 'tldraw'

// Shape Bloc-notes : éditeur texte simple (style Notepad Windows) pour
// prendre des notes sur le canvas OU éditer un fichier texte du disque.
//
// Deux modes coexistent :
//   • Note libre  : `filePath === null`, le contenu vit dans
//     `props.content` et est persisté avec le snapshot tldraw du canvas.
//   • Note liée  : `filePath !== null`, le contenu est lu/écrit sur le
//     disque via les IPC fs.readFile/writeFile. `props.content` est
//     ignoré côté affichage (chargement disque au mount).
//
// Auto-save : 500 ms après la dernière frappe, on flush vers la cible
// appropriée (props tldraw pour note libre, disque pour note liée).
// Affiche un statut "Enregistré" / "…" / "Erreur" dans le header.

const HEADER_HEIGHT = 36

// Délai d'auto-save : assez court pour ne pas perdre 30 s de frappe en
// cas de crash, assez long pour pas spam fs.writeFile à chaque touche.
const AUTOSAVE_DEBOUNCE_MS = 500

// ── Types ─────────────────────────────────────────────────────────────

type NotepadShapeProps = {
  w: number
  h: number
  // Chemin absolu du fichier à éditer, ou null = note libre.
  filePath: string | null
  // Contenu pour les notes libres. Ignoré quand filePath != null.
  // Persisté dans le snapshot tldraw → la note survit au reload du canvas.
  content: string
}

export type NotepadShape = TLBaseShape<'notepad', NotepadShapeProps>

declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    notepad: NotepadShapeProps
  }
}

// État du flush auto-save côté UI.
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

// ── ShapeUtil ─────────────────────────────────────────────────────────

export class NotepadShapeUtil extends BaseBoxShapeUtil<NotepadShape> {
  static override type = 'notepad' as const
  static override props: RecordProps<NotepadShape> = {
    w: T.number,
    h: T.number,
    filePath: T.nullable(T.string),
    content: T.string
  }

  // Migration v1 : pour les snapshots futurs où on aurait omis ces props.
  // Pas de v0 historique car la shape est neuve.
  static override migrations = createShapePropsMigrationSequence({
    sequence: [
      {
        id: 'com.tldraw.shape.notepad/1',
        up(props) {
          const p = props as Record<string, unknown>
          if (typeof p.filePath !== 'string' && p.filePath !== null) {
            p.filePath = null
          }
          if (typeof p.content !== 'string') p.content = ''
        }
      }
    ]
  })

  override getDefaultProps(): NotepadShape['props'] {
    return {
      w: 480,
      h: 360,
      filePath: null,
      content: ''
    }
  }

  override canEdit = (): boolean => true
  override canResize = (): boolean => true

  override onResize(
    shape: NotepadShape,
    info: { scaleX: number; scaleY: number }
  ): { props: { w: number; h: number } } {
    return {
      props: {
        w: Math.max(240, shape.props.w * info.scaleX),
        h: Math.max(160, shape.props.h * info.scaleY)
      }
    }
  }

  override component(shape: NotepadShape) {
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          // Root pointer-events: none → drag tldraw passe à travers le
          // chrome. La textarea + le header surchargent en `auto`.
          pointerEvents: 'none'
        }}
      >
        <NotepadView shape={shape} />
      </HTMLContainer>
    )
  }

  override indicator(shape: NotepadShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={6} ry={6} />
  }
}

// ── Vue ───────────────────────────────────────────────────────────────

const NotepadView = memo(
  function NotepadViewImpl({ shape }: { shape: NotepadShape }) {
    const editor = useEditor()
    const { filePath, content: persistedContent } = shape.props

    // Buffer édité localement. Source de vérité pendant la frappe — le
    // flush vers props/disque est debounced. Initialisé depuis props
    // pour les notes libres, vide en attendant le load pour les liées.
    const [buffer, setBuffer] = useState<string>(filePath === null ? persistedContent : '')
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
    // Erreur de lecture du fichier (note liée). null = pas d'erreur.
    const [loadError, setLoadError] = useState<string | null>(null)
    // Loading uniquement le temps de la première lecture en mode fichier.
    const [loading, setLoading] = useState<boolean>(filePath !== null)

    // ── Chargement initial (mode fichier) ───────────────────────────

    useEffect(() => {
      if (filePath === null) {
        // Mode note libre : on resync le buffer si props.content a changé
        // de manière externe (édition concurrentielle, undo tldraw…).
        setBuffer(persistedContent)
        setLoadError(null)
        setLoading(false)
        return
      }
      let cancelled = false
      setLoading(true)
      setLoadError(null)
      void window.blow.fs.readFile(filePath).then((res) => {
        if (cancelled) return
        if (res.ok) {
          setBuffer(res.content)
        } else {
          setLoadError(res.reason)
          setBuffer('')
        }
        setLoading(false)
      })
      return () => {
        cancelled = true
      }
      // Dépend uniquement du chemin : on recharge si l'utilisateur change
      // le fichier ciblé. Le persistedContent n'est pas pertinent en
      // mode fichier (props.content est ignoré).
    }, [filePath, persistedContent])

    // ── Auto-save debounce ──────────────────────────────────────────

    // Référence stable au timer pour le clear quand le composant unmount
    // ou que le buffer change avant que le timer n'expire.
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Flag pour ignorer le tout premier render (sinon on flush avec le
    // contenu initial à chaque mount, ce qui est inutile et marquerait
    // "saving" sans raison).
    const skipNextFlushRef = useRef<boolean>(true)

    useEffect(() => {
      // Skip le flush au mount initial (buffer chargé du disque ou
      // initialisé depuis props : pas une vraie modif user).
      if (skipNextFlushRef.current) {
        skipNextFlushRef.current = false
        return
      }
      // En mode fichier, pas de flush tant que le contenu n'est pas
      // chargé (sinon on overwrite le fichier avec une string vide).
      if (loading) return
      // En mode fichier, ne pas écrire si on a une erreur de lecture
      // (le fichier n'existe peut-être pas / lecture refusée — préserver
      // au cas où l'utilisateur n'aurait pas voulu écraser).
      if (filePath !== null && loadError !== null) return

      setSaveStatus('pending')
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
      }
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        setSaveStatus('saving')
        if (filePath === null) {
          // Note libre : flush vers les props tldraw. updateShape déclenche
          // un re-snapshot du canvas (auto-save debounced côté store).
          editor.updateShape<NotepadShape>({
            id: shape.id,
            type: 'notepad',
            props: { content: buffer }
          })
          setSaveStatus('saved')
        } else {
          // Note liée : write disque.
          void window.blow.fs.writeFile(filePath, buffer).then((res) => {
            if (res.ok) setSaveStatus('saved')
            else setSaveStatus('error')
          })
        }
      }, AUTOSAVE_DEBOUNCE_MS)

      return () => {
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
      }
      // editor / shape.id sont stables sur la durée de vie du composant —
      // pas la peine de re-armer le timer pour ça.
    }, [buffer, filePath, loading, loadError, editor, shape.id])

    // Flush forcé : Ctrl+S ou unmount imminent. Pour le moment seulement
    // raccourci clavier — l'unmount garde le timer en attente, ce qui
    // est OK car React l'annule via le cleanup et le buffer perdu est
    // celui qui n'avait pas atteint AUTOSAVE_DEBOUNCE_MS — soit < 500 ms
    // de frappe.
    const flushNow = useCallback(() => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      setSaveStatus('saving')
      if (filePath === null) {
        editor.updateShape<NotepadShape>({
          id: shape.id,
          type: 'notepad',
          props: { content: buffer }
        })
        setSaveStatus('saved')
      } else {
        void window.blow.fs.writeFile(filePath, buffer).then((res) => {
          setSaveStatus(res.ok ? 'saved' : 'error')
        })
      }
    }, [buffer, filePath, editor, shape.id])

    // ── Désélection tldraw au focus textarea ───────────────────────

    // Quand l'utilisateur clique dans la textarea, on désélectionne la
    // shape pour éviter que tldraw n'intercepte les touches (Suppr →
    // delete shape, etc.). Pattern miroir à ExplorerShape et aux portails.
    const onInteractivePointerDown = useCallback(
      (e: React.PointerEvent) => {
        e.stopPropagation()
        if (editor.getSelectedShapeIds().length > 0) {
          editor.setSelectedShapes([])
        }
      },
      [editor]
    )

    // Listener natif `wheel` : laisse passer le scroll de la textarea
    // sans que tldraw ne le transforme en zoom canvas. Cf. ExplorerShape
    // pour le rationnel.
    const interactiveRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const el = interactiveRef.current
      if (!el) return
      const onWheel = (e: WheelEvent): void => {
        e.stopPropagation()
      }
      el.addEventListener('wheel', onWheel, { passive: true })
      return () => el.removeEventListener('wheel', onWheel)
    }, [])

    // Raccourcis : Ctrl+S = flush immédiat. La textarea capture le reste.
    const onKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.ctrlKey && e.key.toLowerCase() === 's') {
          e.preventDefault()
          flushNow()
        }
        // Empêche tldraw de capturer les touches de navigation/édition
        // (notamment Suppr qui supprimerait la shape).
        e.stopPropagation()
      },
      [flushNow]
    )

    // ── Render ──────────────────────────────────────────────────────

    const title = filePath === null ? 'Sans titre' : basenameWin(filePath)

    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-primary, #0a0a0a)',
          color: 'var(--fg-primary, #e5e5e5)',
          border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 'var(--radius-md, 8px)',
          overflow: 'hidden',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 13,
          pointerEvents: 'none'
        }}
      >
        {/* Header : titre + statut. pointer-events none → drag tldraw passe
            à travers. */}
        <div
          data-shape-header
          style={{
            height: HEADER_HEIGHT,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 10px',
            background: 'var(--bg-secondary, #101010)',
            borderBottom: '1px solid var(--border, #2a2a2a)',
            pointerEvents: 'none',
            gap: 8
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              flex: 1
            }}
          >
            <span style={{ fontSize: 14 }}>📝</span>
            <span
              title={filePath ?? 'Note libre'}
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
                color: 'var(--fg-primary)'
              }}
            >
              {title}
            </span>
          </div>
          <SaveStatusBadge status={saveStatus} hasError={loadError !== null} />
        </div>

        {/* Zone éditable : textarea plein-écran. */}
        <div
          ref={interactiveRef}
          onPointerDown={onInteractivePointerDown}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            pointerEvents: 'auto'
          }}
        >
          {loading ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--fg-muted)',
                fontSize: 12
              }}
            >
              Chargement…
            </div>
          ) : loadError !== null ? (
            <div
              style={{
                flex: 1,
                padding: 16,
                color: '#e57373',
                fontSize: 12,
                whiteSpace: 'pre-wrap'
              }}
            >
              Impossible d'ouvrir le fichier : {humanizeError(loadError)}
            </div>
          ) : (
            <textarea
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              placeholder={
                filePath === null ? 'Écrivez votre note ici…' : ''
              }
              style={{
                flex: 1,
                resize: 'none',
                background: 'transparent',
                color: 'var(--fg-primary)',
                border: 'none',
                outline: 'none',
                padding: 12,
                fontFamily:
                  'ui-monospace, "Cascadia Mono", "Consolas", "Menlo", monospace',
                fontSize: 13,
                lineHeight: 1.5,
                tabSize: 4
              }}
            />
          )}
        </div>
      </div>
    )
  },
  (prev, next) =>
    prev.shape.id === next.shape.id &&
    prev.shape.props.w === next.shape.props.w &&
    prev.shape.props.h === next.shape.props.h &&
    prev.shape.props.filePath === next.shape.props.filePath &&
    prev.shape.props.content === next.shape.props.content
)

// ── Save status badge ─────────────────────────────────────────────────

function SaveStatusBadge({
  status,
  hasError
}: {
  status: SaveStatus
  hasError: boolean
}): React.ReactElement | null {
  if (hasError) return null
  let label: string
  let color: string
  switch (status) {
    case 'idle':
      return null
    case 'pending':
      label = '…'
      color = 'var(--fg-muted)'
      break
    case 'saving':
      label = 'Enregistrement…'
      color = 'var(--fg-muted)'
      break
    case 'saved':
      label = 'Enregistré'
      color = 'var(--fg-muted)'
      break
    case 'error':
      label = 'Erreur'
      color = '#e57373'
      break
  }
  return (
    <span
      style={{
        fontSize: 10,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function basenameWin(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? path
}

function humanizeError(reason: string): string {
  switch (reason) {
    case 'ENOENT':
      return 'Fichier introuvable.'
    case 'EACCES':
    case 'EPERM':
      return 'Accès refusé (permissions insuffisantes).'
    case 'ENOTDIR':
      return "Ce chemin n'est pas un fichier."
    case 'EISDIR':
      return "Ce chemin est un dossier, pas un fichier."
    case 'EBUSY':
      return 'Fichier verrouillé.'
    case 'fichier-trop-gros':
      return 'Fichier trop volumineux pour le bloc-notes (limite 5 Mo).'
    case 'payload-invalide':
      return 'Requête malformée.'
    default:
      return reason
  }
}
