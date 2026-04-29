import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  createShapePropsMigrationSequence,
  type TLBaseShape,
  type RecordProps
} from 'tldraw'

// Shape Bloc-notes : éditeur texte simple (style Notepad Windows) avec
// barre de menu (Édition / Format) et barre Rechercher/Remplacer.
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

const HEADER_HEIGHT = 36
const MENUBAR_HEIGHT = 28

// Délai d'auto-save : assez court pour ne pas perdre 30 s de frappe en
// cas de crash, assez long pour pas spam fs.writeFile à chaque touche.
const AUTOSAVE_DEBOUNCE_MS = 500

// Bornes de taille de police accessibles via le menu Format.
const FONT_SIZE_MIN = 9
const FONT_SIZE_MAX = 32
const FONT_SIZE_STEP = 1

// ── Types ─────────────────────────────────────────────────────────────

type NotepadShapeProps = {
  w: number
  h: number
  // Chemin absolu du fichier à éditer, ou null = note libre.
  filePath: string | null
  // Contenu pour les notes libres. Ignoré quand filePath != null.
  // Persisté dans le snapshot tldraw → la note survit au reload du canvas.
  content: string
  // Retour automatique à la ligne (Format > Retour à la ligne). Quand
  // false, la textarea scroll horizontalement (mode "code" notepad).
  wordWrap: boolean
  // Taille de police de la textarea. Bornée à [9, 32] via le menu.
  fontSize: number
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
    content: T.string,
    wordWrap: T.boolean,
    fontSize: T.number
  }

  // Migrations :
  //   v1 : schéma initial (filePath, content)
  //   v2 : ajout wordWrap + fontSize (menu Format)
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
      },
      {
        id: 'com.tldraw.shape.notepad/2',
        up(props) {
          const p = props as Record<string, unknown>
          if (typeof p.wordWrap !== 'boolean') p.wordWrap = true
          if (typeof p.fontSize !== 'number') p.fontSize = 13
        }
      }
    ]
  })

  override getDefaultProps(): NotepadShape['props'] {
    return {
      w: 480,
      h: 360,
      filePath: null,
      content: '',
      wordWrap: true,
      fontSize: 13
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
        w: Math.max(280, shape.props.w * info.scaleX),
        h: Math.max(180, shape.props.h * info.scaleY)
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
    const { filePath, content: persistedContent, wordWrap, fontSize } = shape.props

    // Buffer édité localement. Source de vérité pendant la frappe — le
    // flush vers props/disque est debounced. Initialisé depuis props
    // pour les notes libres, vide en attendant le load pour les liées.
    const [buffer, setBuffer] = useState<string>(filePath === null ? persistedContent : '')
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
    const [loadError, setLoadError] = useState<string | null>(null)
    const [loading, setLoading] = useState<boolean>(filePath !== null)

    // Référence vers la textarea pour exécuter les actions du menu
    // (cut/copy/paste/undo/redo, selectAll, insertText, setSelectionRange).
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // Recherche/Remplacement : null = barre fermée, sinon mode actif.
    const [searchMode, setSearchMode] = useState<'find' | 'replace' | null>(null)

    // ── Chargement initial (mode fichier) ───────────────────────────

    useEffect(() => {
      if (filePath === null) {
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
        if (res.ok) setBuffer(res.content)
        else {
          setLoadError(res.reason)
          setBuffer('')
        }
        setLoading(false)
      })
      return () => {
        cancelled = true
      }
    }, [filePath, persistedContent])

    // ── Auto-save debounce ──────────────────────────────────────────

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const skipNextFlushRef = useRef<boolean>(true)

    useEffect(() => {
      if (skipNextFlushRef.current) {
        skipNextFlushRef.current = false
        return
      }
      if (loading) return
      if (filePath !== null && loadError !== null) return

      setSaveStatus('pending')
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
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
      }, AUTOSAVE_DEBOUNCE_MS)

      return () => {
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
      }
    }, [buffer, filePath, loading, loadError, editor, shape.id])

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

    // ── Actions menu Édition ────────────────────────────────────────

    // Insère du texte à la position du curseur (remplace la sélection si
    // présente). Met à jour `buffer` en synchro et déplace le curseur
    // après le texte inséré.
    const insertAtCursor = useCallback((text: string) => {
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart ?? buffer.length
      const end = ta.selectionEnd ?? buffer.length
      const next = buffer.slice(0, start) + text + buffer.slice(end)
      setBuffer(next)
      // Repositionne le curseur après l'insertion. Doit être fait après
      // que React ait re-rendu (sinon la valeur change après notre call).
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const pos = start + text.length
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(pos, pos)
        }
      })
    }, [buffer])

    const doUndo = useCallback(() => {
      textareaRef.current?.focus()
      // execCommand est déprécié mais reste le seul moyen pratique de
      // déclencher l'undo natif d'une textarea sans maintenir notre
      // propre pile d'historique. Marche dans tous les Chromium.
      document.execCommand('undo')
    }, [])

    const doRedo = useCallback(() => {
      textareaRef.current?.focus()
      document.execCommand('redo')
    }, [])

    const doCut = useCallback(() => {
      textareaRef.current?.focus()
      document.execCommand('cut')
    }, [])

    const doCopy = useCallback(() => {
      textareaRef.current?.focus()
      document.execCommand('copy')
    }, [])

    const doPaste = useCallback(async () => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      try {
        const text = await navigator.clipboard.readText()
        insertAtCursor(text)
      } catch {
        // Fallback si l'API Clipboard n'est pas dispo (rare sur Electron) :
        // on tente execCommand('paste') même s'il est très limité côté
        // sécurité Chromium hors gesture user.
        document.execCommand('paste')
      }
    }, [insertAtCursor])

    const doSelectAll = useCallback(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(0, ta.value.length)
    }, [])

    // Insère la date/heure courante au format Notepad Windows, fuseau
    // utilisateur. Asia/Dubai (UTC+4, sans DST) est le fuseau projet.
    const doInsertDateTime = useCallback(() => {
      const fmt = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
      const parts = fmt.formatToParts(new Date())
      const get = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? ''
      const stamp = `${get('hour')}:${get('minute')} ${get('day')}/${get('month')}/${get('year')}`
      insertAtCursor(stamp)
    }, [insertAtCursor])

    // ── Actions menu Format ─────────────────────────────────────────

    const setWordWrap = useCallback(
      (next: boolean) => {
        editor.updateShape<NotepadShape>({
          id: shape.id,
          type: 'notepad',
          props: { wordWrap: next }
        })
      },
      [editor, shape.id]
    )

    const setFontSize = useCallback(
      (next: number) => {
        const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, next))
        editor.updateShape<NotepadShape>({
          id: shape.id,
          type: 'notepad',
          props: { fontSize: clamped }
        })
      },
      [editor, shape.id]
    )

    // ── Désélection tldraw / Wheel propre ──────────────────────────

    const onInteractivePointerDown = useCallback(
      (e: React.PointerEvent) => {
        e.stopPropagation()
        if (editor.getSelectedShapeIds().length > 0) {
          editor.setSelectedShapes([])
        }
      },
      [editor]
    )

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

    // ── Raccourcis clavier ──────────────────────────────────────────

    const onTextareaKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.ctrlKey && e.key.toLowerCase() === 's') {
          e.preventDefault()
          flushNow()
        } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          setSearchMode('find')
        } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
          e.preventDefault()
          setSearchMode('replace')
        } else if (e.key === 'F5') {
          e.preventDefault()
          doInsertDateTime()
        }
        // Empêche tldraw de capturer les touches (sinon Suppr supprime
        // la shape, etc.).
        e.stopPropagation()
      },
      [flushNow, doInsertDateTime]
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

        {/* Barre de menu : Édition / Format. pointer-events auto pour les
            boutons (chacun stoppe propagation pour ne pas trigger drag). */}
        <MenuBar
          disabled={loading || loadError !== null}
          wordWrap={wordWrap}
          fontSize={fontSize}
          onUndo={doUndo}
          onRedo={doRedo}
          onCut={doCut}
          onCopy={doCopy}
          onPaste={doPaste}
          onSelectAll={doSelectAll}
          onInsertDateTime={doInsertDateTime}
          onOpenFind={() => setSearchMode('find')}
          onOpenReplace={() => setSearchMode('replace')}
          onToggleWordWrap={() => setWordWrap(!wordWrap)}
          onSetFontSize={setFontSize}
        />

        {/* Zone éditable. */}
        <div
          ref={interactiveRef}
          onPointerDown={onInteractivePointerDown}
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
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
              ref={textareaRef}
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              onKeyDown={onTextareaKeyDown}
              spellCheck={false}
              wrap={wordWrap ? 'soft' : 'off'}
              placeholder={filePath === null ? 'Écrivez votre note ici…' : ''}
              // Classe activée en mode recherche → surlignage jaune des
              // matches via `::selection` scopé (cf. <style> injecté plus
              // bas). En mode édition normale, la sélection garde la
              // couleur système par défaut.
              className={searchMode !== null ? 'notepad-search-active' : undefined}
              style={{
                flex: 1,
                resize: 'none',
                background: 'transparent',
                color: 'var(--fg-primary)',
                border: 'none',
                outline: 'none',
                padding: 12,
                paddingBottom: searchMode !== null ? 56 : 12,
                fontFamily:
                  'ui-monospace, "Cascadia Mono", "Consolas", "Menlo", monospace',
                fontSize,
                lineHeight: 1.5,
                tabSize: 4,
                whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                overflowWrap: wordWrap ? 'break-word' : 'normal'
              }}
            />
          )}

          {searchMode !== null && !loading && loadError === null && (
            <>
              {/* Surlignage jaune des occurrences pendant la recherche.
                  ::selection ne peut pas être inline-style → on injecte une
                  règle scopée à la classe `notepad-search-active`. !important
                  pour passer outre les éventuels styles agent-utilisateur. */}
              <style>{`
                textarea.notepad-search-active::selection {
                  background: #ffeb3b !important;
                  color: #000 !important;
                }
                textarea.notepad-search-active::-moz-selection {
                  background: #ffeb3b !important;
                  color: #000 !important;
                }
              `}</style>
              <SearchBar
                mode={searchMode}
                buffer={buffer}
                setBuffer={setBuffer}
                textareaRef={textareaRef}
                onClose={() => {
                  setSearchMode(null)
                  textareaRef.current?.focus()
                }}
                onSwitchMode={(m) => setSearchMode(m)}
              />
            </>
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
    prev.shape.props.content === next.shape.props.content &&
    prev.shape.props.wordWrap === next.shape.props.wordWrap &&
    prev.shape.props.fontSize === next.shape.props.fontSize
)

// ── MenuBar ───────────────────────────────────────────────────────────

function MenuBar({
  disabled,
  wordWrap,
  fontSize,
  onUndo,
  onRedo,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
  onInsertDateTime,
  onOpenFind,
  onOpenReplace,
  onToggleWordWrap,
  onSetFontSize
}: {
  disabled: boolean
  wordWrap: boolean
  fontSize: number
  onUndo: () => void
  onRedo: () => void
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onSelectAll: () => void
  onInsertDateTime: () => void
  onOpenFind: () => void
  onOpenReplace: () => void
  onToggleWordWrap: () => void
  onSetFontSize: (next: number) => void
}): React.ReactElement {
  // Quel menu est actuellement ouvert (null = aucun). Single-source pour
  // que cliquer sur "Format" ferme "Édition" automatiquement.
  const [openMenu, setOpenMenu] = useState<'edit' | 'format' | null>(null)
  const editBtnRef = useRef<HTMLButtonElement>(null)
  const formatBtnRef = useRef<HTMLButtonElement>(null)
  // Référence stable pour le close handler — évite de recréer la fonction
  // à chaque render, ce qui fait re-tirer le useEffect du MenuDropdown
  // (et avec son defer setTimeout(0), peut empêcher l'attachement effectif
  // du listener "click outside" si MenuBar re-render avant le tick).
  const closeMenu = useCallback(() => setOpenMenu(null), [])

  return (
    <div
      data-shape-header
      style={{
        height: MENUBAR_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--bg-secondary, #101010)',
        borderBottom: '1px solid var(--border, #2a2a2a)',
        // Le fond de la menubar laisse passer le drag tldraw, mais les
        // boutons enfants sont en `auto`.
        pointerEvents: 'none'
      }}
    >
      <MenuBarButton
        ref={editBtnRef}
        label="Édition"
        active={openMenu === 'edit'}
        disabled={disabled}
        onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
      />
      <MenuBarButton
        ref={formatBtnRef}
        label="Format"
        active={openMenu === 'format'}
        disabled={disabled}
        onClick={() => setOpenMenu(openMenu === 'format' ? null : 'format')}
      />

      {openMenu === 'edit' && (
        <MenuDropdown
          anchorRef={editBtnRef}
          onClose={closeMenu}
        >
          <DropdownItem label="Annuler" shortcut="Ctrl+Z" onClick={() => { onUndo(); setOpenMenu(null) }} />
          <DropdownItem label="Rétablir" shortcut="Ctrl+Y" onClick={() => { onRedo(); setOpenMenu(null) }} />
          <DropdownSeparator />
          <DropdownItem label="Couper" shortcut="Ctrl+X" onClick={() => { onCut(); setOpenMenu(null) }} />
          <DropdownItem label="Copier" shortcut="Ctrl+C" onClick={() => { onCopy(); setOpenMenu(null) }} />
          <DropdownItem label="Coller" shortcut="Ctrl+V" onClick={() => { onPaste(); setOpenMenu(null) }} />
          <DropdownItem label="Tout sélectionner" shortcut="Ctrl+A" onClick={() => { onSelectAll(); setOpenMenu(null) }} />
          <DropdownSeparator />
          <DropdownItem label="Heure/Date" shortcut="F5" onClick={() => { onInsertDateTime(); setOpenMenu(null) }} />
          <DropdownSeparator />
          <DropdownItem label="Rechercher…" shortcut="Ctrl+F" onClick={() => { onOpenFind(); setOpenMenu(null) }} />
          <DropdownItem label="Remplacer…" shortcut="Ctrl+H" onClick={() => { onOpenReplace(); setOpenMenu(null) }} />
        </MenuDropdown>
      )}

      {openMenu === 'format' && (
        <MenuDropdown
          anchorRef={formatBtnRef}
          onClose={closeMenu}
        >
          <DropdownItem
            label="Retour automatique à la ligne"
            checked={wordWrap}
            onClick={() => { onToggleWordWrap(); setOpenMenu(null) }}
          />
          <DropdownSeparator />
          <DropdownItem
            label={`Taille du texte : ${fontSize} px`}
            disabled
          />
          <DropdownItem
            label="Augmenter (A+)"
            shortcut="Ctrl++"
            onClick={() => onSetFontSize(fontSize + FONT_SIZE_STEP)}
            disabled={fontSize >= FONT_SIZE_MAX}
          />
          <DropdownItem
            label="Diminuer (A−)"
            shortcut="Ctrl+−"
            onClick={() => onSetFontSize(fontSize - FONT_SIZE_STEP)}
            disabled={fontSize <= FONT_SIZE_MIN}
          />
          <DropdownItem
            label="Taille par défaut (13)"
            onClick={() => { onSetFontSize(13); setOpenMenu(null) }}
            disabled={fontSize === 13}
          />
        </MenuDropdown>
      )}
    </div>
  )
}

// Bouton de la menubar (titre + caret implicite). Stop propagation pointer
// pour ne pas démarrer un drag tldraw.
const MenuBarButton = ({
  ref,
  label,
  active,
  disabled,
  onClick
}: {
  ref: React.RefObject<HTMLButtonElement | null>
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}): React.ReactElement => (
  <button
    ref={ref}
    type="button"
    disabled={disabled}
    onClick={(e) => {
      e.stopPropagation()
      if (!disabled) onClick()
    }}
    onPointerDown={(e) => e.stopPropagation()}
    onMouseDown={(e) => e.stopPropagation()}
    style={{
      background: active ? 'var(--bg-tertiary, #1a1a1a)' : 'transparent',
      color: disabled ? 'var(--fg-muted)' : 'var(--fg-primary)',
      border: 'none',
      padding: '0 10px',
      fontFamily: 'inherit',
      fontSize: 12,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      pointerEvents: 'auto'
    }}
    onMouseEnter={(e) => {
      if (!disabled && !active) e.currentTarget.style.background = 'var(--bg-tertiary)'
    }}
    onMouseLeave={(e) => {
      if (!active) e.currentTarget.style.background = 'transparent'
    }}
  >
    {label}
  </button>
)

// Dropdown portallé vers document.body : nécessaire car la shape est
// rendue dans le canvas tldraw qui applique `transform: scale()` pour
// le zoom — `position: fixed` n'échappe pas à un containing block créé
// par transform. Pattern identique au menu contextuel de l'Explorer.
function MenuDropdown({
  anchorRef,
  onClose,
  children
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  // Position INITIALE calculée dès le premier render via useState lazy
  // initializer : sans ça, le menu est rendu à (0, 0) puis re-positionné
  // au tick suivant via useEffect, ce qui crée un flash visible en haut
  // à gauche de l'écran ("menu fantôme"). L'initializer s'exécute une
  // fois au mount, donc anchorRef.current est déjà disponible (le bouton
  // ancre est rendu avant l'ouverture du dropdown).
  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    const a = anchorRef.current
    if (!a) return { left: -9999, top: -9999 } // hors écran si non ancré
    const r = a.getBoundingClientRect()
    return { left: r.left, top: r.bottom }
  })

  // Recalcul de position avant la peinture du browser (useLayoutEffect)
  // pour couvrir le cas où l'ancre s'est déplacée entre le mount et le
  // commit (resize, scroll, drag de la shape). useEffect serait async
  // après peinture → flash visible.
  useLayoutEffect(() => {
    if (!anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    setPos({ left: r.left, top: r.bottom })
  }, [anchorRef])

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Si le clic vient du bouton ancre lui-même, ne pas fermer ici
        // (le bouton va toggle on→off via son onClick).
        if (anchorRef.current && anchorRef.current.contains(e.target as Node)) {
          return
        }
        onClose()
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    // Différer l'attachement au prochain tick : sans ce defer, le mousedown
    // qui a OUVERT le menu (déjà en cours de propagation au moment où
    // useEffect run en mode capture sur d'autres listeners globaux) peut
    // encore atteindre notre listener et fermer le menu instantanément.
    // Le tick suivant garantit qu'on ne capture que les clics POSTÉRIEURS
    // à l'ouverture.
    let attached = false
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('keydown', onKey, true)
      attached = true
    }, 0)
    return () => {
      clearTimeout(timeoutId)
      if (attached) {
        document.removeEventListener('mousedown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }
  }, [onClose, anchorRef])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        minWidth: 220,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        zIndex: 1000,
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        fontSize: 12,
        pointerEvents: 'auto',
        color: 'var(--fg-primary)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
      }}
    >
      {children}
    </div>,
    document.body
  )
}

function DropdownItem({
  label,
  shortcut,
  checked,
  disabled,
  onClick
}: {
  label: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  onClick?: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled && onClick) onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        background: 'transparent',
        color: disabled ? 'var(--fg-muted)' : 'var(--fg-primary)',
        border: 'none',
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        fontSize: 12,
        textAlign: 'left',
        opacity: disabled ? 0.5 : 1
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-tertiary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span style={{ width: 14, textAlign: 'center', color: 'var(--fg-muted)' }}>
        {checked ? '✓' : ''}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {shortcut && (
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{shortcut}</span>
      )}
    </button>
  )
}

function DropdownSeparator(): React.ReactElement {
  return (
    <div
      style={{
        height: 1,
        background: 'var(--border)',
        margin: '4px 0'
      }}
    />
  )
}

// ── Search bar ────────────────────────────────────────────────────────

function SearchBar({
  mode,
  buffer,
  setBuffer,
  textareaRef,
  onClose,
  onSwitchMode
}: {
  mode: 'find' | 'replace'
  buffer: string
  setBuffer: (s: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onClose: () => void
  onSwitchMode: (m: 'find' | 'replace') => void
}): React.ReactElement {
  const [query, setQuery] = useState<string>('')
  const [replaceValue, setReplaceValue] = useState<string>('')
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false)
  const queryInputRef = useRef<HTMLInputElement>(null)

  // Focus auto à l'ouverture / changement de mode.
  useEffect(() => {
    queryInputRef.current?.focus()
    queryInputRef.current?.select()
  }, [mode])

  // Cherche la prochaine occurrence depuis la position courante du
  // curseur (ou la sélection courante en mode "next after current match").
  // Scroll automatiquement la textarea pour rendre l'occurrence visible.
  const findOccurrence = useCallback(
    (direction: 1 | -1) => {
      if (!query) return
      const ta = textareaRef.current
      if (!ta) return
      const haystack = caseSensitive ? buffer : buffer.toLowerCase()
      const needle = caseSensitive ? query : query.toLowerCase()
      if (!needle) return
      const cursor =
        direction === 1
          ? (ta.selectionEnd ?? 0)
          : (ta.selectionStart ?? buffer.length)
      let idx: number
      if (direction === 1) {
        idx = haystack.indexOf(needle, cursor)
        if (idx === -1) idx = haystack.indexOf(needle, 0) // wrap
      } else {
        idx = haystack.lastIndexOf(needle, cursor - 1)
        if (idx === -1) idx = haystack.lastIndexOf(needle) // wrap
      }
      if (idx === -1) return
      ta.focus()
      ta.setSelectionRange(idx, idx + needle.length)
      scrollTextareaToSelection(ta)
    },
    [query, buffer, caseSensitive, textareaRef]
  )

  // Remplace la sélection courante SI elle correspond au pattern, puis
  // avance à l'occurrence suivante. Comportement attendu de Notepad.
  const replaceCurrent = useCallback(() => {
    if (!query) return
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart ?? 0
    const end = ta.selectionEnd ?? 0
    const selected = buffer.slice(start, end)
    const matches = caseSensitive
      ? selected === query
      : selected.toLowerCase() === query.toLowerCase()
    if (matches) {
      const next = buffer.slice(0, start) + replaceValue + buffer.slice(end)
      setBuffer(next)
      requestAnimationFrame(() => {
        const newPos = start + replaceValue.length
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(newPos, newPos)
          scrollTextareaToSelection(textareaRef.current)
          // Cherche la prochaine occurrence après le remplacement (qui
          // appliquera lui-même un scroll vers la nouvelle sélection).
          findOccurrence(1)
        }
      })
    } else {
      // Sélection courante ne matche pas : on cherche la prochaine.
      findOccurrence(1)
    }
  }, [buffer, query, replaceValue, caseSensitive, setBuffer, textareaRef, findOccurrence])

  const replaceAll = useCallback(() => {
    if (!query) return
    const flags = caseSensitive ? 'g' : 'gi'
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, flags)
    const next = buffer.replace(re, replaceValue)
    setBuffer(next)
  }, [buffer, query, replaceValue, caseSensitive, setBuffer])

  // Compteur de matches (informatif).
  const matchCount = useMemo(() => {
    if (!query) return 0
    const haystack = caseSensitive ? buffer : buffer.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    let count = 0
    let pos = 0
    while (true) {
      const idx = haystack.indexOf(needle, pos)
      if (idx === -1) break
      count++
      pos = idx + needle.length
      if (count > 9999) break // garde-fou
    }
    return count
  }, [buffer, query, caseSensitive])

  const onQueryKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        findOccurrence(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [findOccurrence, onClose]
  )

  return (
    <div
      // stopPropagation pour qu'un clic dans la barre ne désélectionne pas
      // la zone interactive et ne lance pas le drag tldraw.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 8,
        background: 'var(--bg-secondary, #101010)',
        border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 6,
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          ref={queryInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKeyDown}
          placeholder="Rechercher…"
          style={{
            flex: 1,
            minWidth: 0,
            height: 24,
            padding: '0 8px',
            background: 'var(--bg-primary)',
            color: 'var(--fg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontFamily: 'inherit',
            fontSize: 12,
            outline: 'none'
          }}
        />
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', minWidth: 60, textAlign: 'center' }}>
          {query ? `${matchCount} occ.` : ''}
        </span>
        <SearchButton title="Précédent (Maj+Entrée)" onClick={() => findOccurrence(-1)}>↑</SearchButton>
        <SearchButton title="Suivant (Entrée)" onClick={() => findOccurrence(1)}>↓</SearchButton>
        <SearchButton
          title="Sensible à la casse"
          onClick={() => setCaseSensitive((v) => !v)}
          active={caseSensitive}
        >
          Aa
        </SearchButton>
        <SearchButton
          title={mode === 'find' ? 'Mode remplacer' : 'Mode rechercher'}
          onClick={() => onSwitchMode(mode === 'find' ? 'replace' : 'find')}
          active={mode === 'replace'}
        >
          ⇄
        </SearchButton>
        <SearchButton title="Fermer (Échap)" onClick={onClose}>✕</SearchButton>
      </div>

      {mode === 'replace' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="text"
            value={replaceValue}
            onChange={(e) => setReplaceValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                replaceCurrent()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
            placeholder="Remplacer par…"
            style={{
              flex: 1,
              minWidth: 0,
              height: 24,
              padding: '0 8px',
              background: 'var(--bg-primary)',
              color: 'var(--fg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontFamily: 'inherit',
              fontSize: 12,
              outline: 'none'
            }}
          />
          <span style={{ minWidth: 60 }} />
          <SearchButton title="Remplacer (Entrée)" onClick={replaceCurrent}>R1</SearchButton>
          <SearchButton title="Tout remplacer" onClick={replaceAll}>R∗</SearchButton>
        </div>
      )}
    </div>
  )
}

function SearchButton({
  children,
  title,
  active,
  onClick
}: {
  children: React.ReactNode
  title: string
  active?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        height: 24,
        minWidth: 28,
        padding: '0 6px',
        background: active ? 'var(--bg-tertiary)' : 'transparent',
        color: 'var(--fg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 11
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--bg-tertiary)'
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

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

// Scroll la textarea pour rendre la sélection courante visible. Sans ce
// helper, `setSelectionRange` ne scroll pas systématiquement (Chromium
// scroll uniquement si la textarea avait déjà le focus AVANT le call,
// ce qui n'est pas notre cas quand le focus est dans la search bar).
//
// Algo : on construit un <div> miroir hors écran avec exactement les
// mêmes propriétés visuelles que la textarea (police, padding, wrap…),
// on y insère le texte AVANT la position de sélection + un span sentinel,
// on lit `offsetTop` du sentinel pour connaître la position visuelle (en
// px) de la sélection, puis on ajuste `scrollTop` de la textarea pour
// que cette position soit centrée dans la zone visible.
function scrollTextareaToSelection(ta: HTMLTextAreaElement): void {
  const start = ta.selectionStart ?? 0
  const style = window.getComputedStyle(ta)
  const mirror = document.createElement('div')
  // Propriétés qui affectent le rendu et le retour à la ligne.
  const propsToCopy: Array<keyof CSSStyleDeclaration> = [
    'boxSizing',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderTopStyle',
    'borderRightStyle',
    'borderBottomStyle',
    'borderLeftStyle',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'fontFamily',
    'lineHeight',
    'textAlign',
    'textTransform',
    'textIndent',
    'textDecoration',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'whiteSpace',
    'wordWrap',
    'overflowWrap'
  ]
  for (const prop of propsToCopy) {
    // Cast nécessaire car CSSStyleDeclaration[K] peut être readonly côté types.
    ;(mirror.style as unknown as Record<string, string>)[prop as string] =
      (style as unknown as Record<string, string>)[prop as string] ?? ''
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '0'
  mirror.style.width = `${ta.clientWidth}px`
  mirror.style.height = 'auto'
  mirror.style.overflow = 'hidden'

  mirror.textContent = ta.value.substring(0, start)
  const sentinel = document.createElement('span')
  // Zero-width space pour ne pas affecter le wrap.
  sentinel.textContent = '​'
  mirror.appendChild(sentinel)

  document.body.appendChild(mirror)
  const sentinelTop = sentinel.offsetTop
  document.body.removeChild(mirror)

  // Marge confortable haut/bas pour ne pas coller au bord visible.
  const margin = 24
  const visibleTop = ta.scrollTop
  const visibleBottom = ta.scrollTop + ta.clientHeight
  if (sentinelTop < visibleTop + margin || sentinelTop > visibleBottom - margin) {
    ta.scrollTop = Math.max(0, sentinelTop - ta.clientHeight / 2)
  }
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
