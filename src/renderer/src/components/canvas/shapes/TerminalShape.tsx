import { useEffect, useRef, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  type TLBaseShape,
  type RecordProps
} from 'tldraw'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useProjectStore } from '../../../stores/project-store.js'
import { useEditorStore } from '../../../stores/editor-store.js'
import { useUIStore } from '../../../stores/ui-store.js'
import { spawnBrowserShape } from '../InfiniteCanvas.js'
import {
  useShapeBorderState,
  getShapeBorderStyle
} from '../../../lib/use-shape-border-state.js'

// Shape "Terminal" : xterm.js branché sur un PTY + assignation à un projet.

type TerminalShapeProps = {
  w: number
  h: number
  shell: 'powershell' | 'cmd' | 'bash' | 'pwsh'
  cwd: string
  projectId: string | null
  spawned: boolean
}

export type TerminalShape = TLBaseShape<'terminal', TerminalShapeProps>

// Enregistre la shape custom dans l'union globale de tldraw v4 afin d'éviter
// les casts `any` sur editor.updateShape / editor.createShape.
declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    terminal: TerminalShapeProps
  }
}

export class TerminalShapeUtil extends BaseBoxShapeUtil<TerminalShape> {
  static override type = 'terminal' as const
  static override props: RecordProps<TerminalShape> = {
    w: T.number,
    h: T.number,
    shell: T.literalEnum('powershell', 'cmd', 'bash', 'pwsh'),
    cwd: T.string,
    projectId: T.string.nullable(),
    spawned: T.boolean
  }

  override getDefaultProps(): TerminalShape['props'] {
    return {
      w: 640,
      h: 380,
      shell: 'powershell',
      cwd: 'C:/Users/Blowdok/Desktop',
      projectId: null,
      spawned: false
    }
  }

  override canEdit = (): boolean => true
  override canResize = (): boolean => true
  override isAspectRatioLocked = (): boolean => false

  override onResize(
    shape: TerminalShape,
    info: { scaleX: number; scaleY: number }
  ): { props: { w: number; h: number } } {
    return {
      props: {
        w: Math.max(240, shape.props.w * info.scaleX),
        h: Math.max(140, shape.props.h * info.scaleY)
      }
    }
  }

  // Placeholder transparent : le contenu réel (xterm + PTY) vit hors
  // tldraw dans `ShapePortalManager`. Évite le remount xterm au page
  // switch tldraw — même pattern que VSCodeShape. Le `data-blowworks-
  // shape-id` permet au portail de retrouver la position DOM exacte
  // (BCR) où tldraw rend la shape.
  override component(shape: TerminalShape) {
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          background: 'transparent',
          pointerEvents: 'none'
        }}
      >
        <div
          data-blowworks-shape-id={shape.id}
          style={{ width: '100%', height: '100%' }}
        />
      </HTMLContainer>
    )
  }

  override indicator(shape: TerminalShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}

const SHELL_OPTIONS: TerminalShape['props']['shell'][] = ['powershell', 'pwsh', 'cmd', 'bash']

// Contenu réel de la shape Terminal — rendu hors tldraw par
// `ShapePortalManager` pour préserver l'instance xterm lors des switch
// de pages. Le PTY côté main process survivait déjà (pty-manager tient
// l'ID), mais l'instance xterm côté renderer était détruite. Maintenant
// xterm + scrollback affichés sont préservés cross-page.
export function TerminalPortalContent({ shape }: { shape: TerminalShape }) {
  return <TerminalShapeView shape={shape} />
}

function TerminalShapeView({ shape }: { shape: TerminalShape }) {
  const editor = useEditor()
  const projects = useProjectStore((s) => s.projects)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [shellDropdownOpen, setShellDropdownOpen] = useState(false)

  const assignedProject = projects.find((p) => p.id === shape.props.projectId) ?? null

  // Bordure immersive unifiée : hover / sélection / fade 5 s / projet.
  // Cf. `src/renderer/src/lib/use-shape-border-state.ts` pour la logique.
  const borderState = useShapeBorderState(shape.id)
  const borderStyle = getShapeBorderStyle(borderState, assignedProject?.color ?? null)

  function setProjectId(projectId: string | null): void {
    editor.updateShape<TerminalShape>({
      id: shape.id,
      type: 'terminal',
      props: { projectId }
    })
    setDropdownOpen(false)
  }

  function setShell(shell: TerminalShape['props']['shell']): void {
    setShellDropdownOpen(false)
    if (shell === shape.props.shell) return
    editor.updateShape<TerminalShape>({
      id: shape.id,
      type: 'terminal',
      props: { shell }
    })
    // Mémorise comme défaut pour les futurs terminaux spawnés.
    useUIStore.getState().setLastShell(shell)
  }

  // Stoppe la propagation pointer/touch uniquement sur les éléments interactifs :
  // laisse tldraw recevoir le pointer-down sur le conteneur pour pouvoir sélectionner
  // la shape, tout en autorisant les clics locaux sur les boutons.
  const stopInteractive = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onTouchEnd: (e: React.TouchEvent) => e.stopPropagation()
  }

  return (
    <div
      style={{
        // Root `pointer-events: none` : permet le drag tldraw via le
        // header (pass-through vers la shape placeholder sous-jacente).
        // Les éléments interactifs (boutons, dropdowns, xterm) utilisent
        // explicitement `pointer-events: auto`. Même pattern que
        // VSCodeShape.
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'hidden',
        background: 'var(--bg-primary, #000)',
        border: borderStyle.border,
        boxShadow: borderStyle.boxShadow,
        transition: borderStyle.transition,
        borderRadius: 'var(--radius-md, 8px)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div
        data-shape-header
        className="relative flex h-7 items-center justify-between border-b px-2 text-[11px]"
        style={{
          background: 'var(--bg-secondary, #101010)',
          borderColor: 'var(--border, #2a2a2a)',
          color: 'var(--fg-primary, #e5e5e5)',
          pointerEvents: 'none'
        }}
      >
        <div className="relative flex min-w-0 items-center gap-1 font-mono">
          <button
            type="button"
            onClick={() => setShellDropdownOpen((v) => !v)}
            className="rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--bg-tertiary)]"
            style={{ color: 'var(--fg-secondary, #00ffff)', pointerEvents: 'auto' }}
            // Le cwd est retiré du header (redondant avec le prompt du shell).
            // On le garde en tooltip pour info au survol du bouton shell.
            title={`Changer le shell · ${shape.props.cwd}`}
            {...stopInteractive}
          >
            {shape.props.shell} ▾
          </button>

          {shellDropdownOpen && (
            <div
              className="absolute left-0 top-7 z-10 min-w-[140px] overflow-hidden rounded border text-[11px] shadow-lg"
              style={{
                background: 'var(--bg-secondary, #101010)',
                borderColor: 'var(--border, #2a2a2a)',
                pointerEvents: 'auto'
              }}
              {...stopInteractive}
            >
              {SHELL_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setShell(opt)}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)] ${
                    opt === shape.props.shell ? 'font-semibold' : ''
                  }`}
                  style={{
                    color:
                      opt === shape.props.shell
                        ? 'var(--fg-secondary, #00ffff)'
                        : 'var(--fg-primary, #e5e5e5)'
                  }}
                  {...stopInteractive}
                >
                  <span>{opt === shape.props.shell ? '●' : '○'}</span>
                  <span>{opt}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-mono text-[10px] hover:bg-[var(--bg-tertiary)]"
            style={{
              color: assignedProject ? assignedProject.color : 'var(--fg-primary, #e5e5e5)',
              pointerEvents: 'auto'
            }}
            onClick={() => setDropdownOpen((v) => !v)}
            title="Assigner à un projet"
            {...stopInteractive}
          >
            {assignedProject ? `● ${assignedProject.name}` : '○ aucun projet'}
          </button>
        </div>

        {dropdownOpen && (
          <div
            className="absolute right-2 top-7 z-10 min-w-[180px] overflow-hidden rounded border text-[11px] shadow-lg"
            style={{
              background: 'var(--bg-secondary, #101010)',
              borderColor: 'var(--border, #2a2a2a)',
              pointerEvents: 'auto'
            }}
            {...stopInteractive}
          >
            <button
              type="button"
              onClick={() => setProjectId(null)}
              className="block w-full px-2 py-1.5 text-left text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
              {...stopInteractive}
            >
              ○ Aucun projet
            </button>
            {projects.length === 0 && (
              <div className="px-2 py-1.5 text-[var(--fg-muted)]">
                (créez un projet dans la sidebar)
              </div>
            )}
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)]"
                style={{ color: p.color }}
                {...stopInteractive}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="truncate text-[var(--fg-primary)]">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <TerminalBody shape={shape} />
    </div>
  )
}

function TerminalBody({ shape }: { shape: TerminalShape }) {
  const editor = useEditor()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const serializeRef = useRef<SerializeAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Thème "Matrix immersion" : fond #101011 = couleur canvas tldraw
    // (var `--bg-primary`) → fusion visuelle parfaite avec le reste de
    // l'app, aucune couture entre le terminal et le canvas. Texte en
    // vert phosphore Matrix (#00ff41) pour une lisibilité ambiance
    // « terminal CRT ». Curseur même teinte, accent sombre pour voir
    // le caractère sous le bloc. Sélection verte semi-transparente.
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#101011',
        foreground: '#00ff41',
        cursor: '#00ff41',
        cursorAccent: '#101011',
        selectionBackground: '#00ff4144'
      },
      scrollback: 10_000
    })
    const fit = new FitAddon()
    const serialize = new SerializeAddon()
    // WebLinksAddon : détecte les URLs http(s) dans le scrollback et les
    // rend cliquables. Handler custom : au lieu d'ouvrir le navigateur
    // système (comportement par défaut de l'addon via window.open →
    // setWindowOpenHandler), on spawne directement une BrowserShape sur
    // le canvas courant. Cohérent avec l'UX « tout reste dans BlowWorks ».
    const webLinks = new WebLinksAddon((_event, uri) => {
      const editor = useEditorStore.getState().editor
      if (editor) spawnBrowserShape(editor, uri)
    })
    term.loadAddon(fit)
    term.loadAddon(serialize)
    term.loadAddon(webLinks)

    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    serializeRef.current = serialize

    // Raccourcis clavier interceptés AVANT xterm (pour ne pas être envoyés au
    // PTY). Convention standard sous Windows : Ctrl+Shift+C / V pour copier-
    // coller (Ctrl+C seul reste un SIGINT pour le shell).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        // preventDefault pour bloquer la copie native de la textarea xterm
        // (sinon double copie sans impact, mais autant être propre).
        e.preventDefault()
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection).catch((err) => {
            console.warn('[terminal] copie presse-papiers échouée', err)
          })
        }
        return false
      }

      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        // CRITIQUE : preventDefault bloque le paste natif de Chromium qui
        // collerait le même texte dans la textarea xterm → double-paste.
        e.preventDefault()
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text)
          })
          .catch((err) => {
            console.warn('[terminal] lecture presse-papiers échouée', err)
          })
        return false
      }

      return true
    })

    // Auto-copie de la sélection dès qu'elle est relâchée (convention Linux /
    // mintty — pratique pour piquer des logs sans raccourci clavier).
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel && sel.length > 0) {
        void navigator.clipboard.writeText(sel).catch(() => {
          /* permission refusée ou hors focus : ignorer */
        })
      }
    })

    try {
      const webgl = new WebglAddon()
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('[terminal] WebGL addon indisponible, fallback canvas', err)
    }

    requestAnimationFrame(() => {
      try {
        fit.fit()
        // Donne le focus clavier au terminal dès qu'il est rendu pour permettre
        // la saisie immédiate (sans que l'utilisateur doive cliquer dedans).
        term.focus()
      } catch {
        /* ignore */
      }
    })

    // Bind les handlers d'entrée AVANT le spawn async : si l'utilisateur
    // tape pendant le spawn, les touches sont bufferisées puis flushées dès
    // que le PTY répond (xterm bufferise en interne jusqu'au premier onData).
    // Sans ce découplage, une race perd les premières frappes silencieusement.
    const dataDisposable = term.onData((data) => {
      void window.blow.terminal.write(shape.id, data).catch((err) => {
        console.error('[terminal] write IPC échoué', err)
      })
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void window.blow.terminal.resize(shape.id, cols, rows).catch(() => {})
    })

    // Écoute les événements main→renderer dès le montage (avant spawn) pour ne
    // manquer aucune sortie initiale du PTY (prompt powershell, etc.).
    const detachData = window.blow.terminal.onData((payload) => {
      if (payload.id === shape.id) term.write(payload.data)
    })
    const detachExit = window.blow.terminal.onExit((payload) => {
      if (payload.id === shape.id) {
        term.write(`\r\n\x1b[33m[processus terminé code=${payload.exitCode}]\x1b[0m\r\n`)
      }
    })

    void (async () => {
      try {
        const cols = term.cols
        const rows = term.rows
        const res = (await window.blow.terminal.spawn({
          id: shape.id,
          shell: shape.props.shell,
          cwd: shape.props.cwd,
          cols,
          rows,
          restoreScrollback: true
        })) as { scrollback: string | null }

        if (res.scrollback) term.write(res.scrollback)
      } catch (err) {
        console.error('[terminal] spawn IPC échoué', err)
        term.write(
          `\r\n\x1b[31m[Erreur de lancement du shell : ${String(err)}]\x1b[0m\r\n`
        )
      }
    })()

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      detachData()
      detachExit()
      try {
        const scrollback = serializeRef.current?.serialize() ?? ''
        void window.blow.terminal.persist(shape.id, scrollback)
      } catch (err) {
        console.warn('[terminal] sérialisation scrollback impossible', err)
      }
      term.dispose()
      termRef.current = null
    }
  }, [shape.id, shape.props.shell, shape.props.cwd])

  return (
    <div
      ref={containerRef}
      className="flex-1"
      style={{
        minHeight: 0,
        padding: 4,
        // Aligné sur `theme.background` de xterm et sur `--bg-primary`
        // du canvas pour l'immersion Matrix (zéro couture visible).
        background: '#101011',
        pointerEvents: 'auto'
      }}
      onPointerDown={(e) => {
        // Ramène le focus clavier vers xterm à chaque clic sur la zone
        // terminal. Indispensable car tldraw peut déplacer le focus sur
        // son overlay. Le bring-to-front et la gestion de sélection (mode
        // immersion = désélection tldraw) sont DÉLÉGUÉS au listener
        // global `window.pointerdown` de `ShapePortalManager`, qui fire
        // en capture phase AVANT ce handler React. Si on setSelectedShapes
        // ici, ça annulait la désélection du listener global → bordure
        // bleue tldraw ré-apparaissait.
        e.stopPropagation()
        termRef.current?.focus()
      }}
      onPointerMove={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    />
  )
}
