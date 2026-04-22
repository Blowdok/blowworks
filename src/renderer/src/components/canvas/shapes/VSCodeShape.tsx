import React, { memo, useEffect, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  type TLBaseShape,
  type RecordProps
} from 'tldraw'
import { useProjectStore } from '../../../stores/project-store.js'
import {
  useShapeBorderState,
  getShapeBorderStyle
} from '../../../lib/use-shape-border-state.js'

// Shape VSCode : iframe sur le sidecar openvscode-server local.

type VSCodeShapeProps = {
  w: number
  h: number
  folder: string
  projectId: string | null
}

export type VSCodeShape = TLBaseShape<'vscode', VSCodeShapeProps>

// Enregistre la shape custom dans l'union globale de tldraw v4.
declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    vscode: VSCodeShapeProps
  }
}

export class VSCodeShapeUtil extends BaseBoxShapeUtil<VSCodeShape> {
  static override type = 'vscode' as const
  static override props: RecordProps<VSCodeShape> = {
    w: T.number,
    h: T.number,
    folder: T.string,
    projectId: T.string.nullable()
  }

  override getDefaultProps(): VSCodeShape['props'] {
    return {
      w: 960,
      h: 600,
      folder: '',
      projectId: null
    }
  }

  override canEdit = (): boolean => true
  override canResize = (): boolean => true

  override onResize(
    shape: VSCodeShape,
    info: { scaleX: number; scaleY: number }
  ): { props: { w: number; h: number } } {
    return {
      props: {
        w: Math.max(320, shape.props.w * info.scaleX),
        h: Math.max(200, shape.props.h * info.scaleY)
      }
    }
  }

  // Placeholder transparent : la shape tldraw ne rend qu'un cadre invisible
  // qui sert de zone d'interaction (sélection/resize/move). Le CONTENU réel
  // (iframe VSCode + header + dropdowns) est rendu HORS-tldraw par
  // `ShapePortalManager`, ce qui préserve l'iframe lors des switch de pages
  // tldraw (sinon elle serait unmount et rechargerait le workbench).
  //
  // Le `data-blowworks-shape-id` est la CLÉ DOM qui permet au portail
  // de retrouver exactement où tldraw rend la shape (via BCR) — source
  // de vérité pour éviter tout décalage avec la bordure de sélection
  // tldraw, qui utilise les coords DOM réelles (pas pageToScreen).
  override component(shape: VSCodeShape) {
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

  override indicator(shape: VSCodeShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}

// Contenu réel de la shape VSCode — rendu hors tldraw par ShapePortalManager
// pour préserver l'iframe lors des switch de pages. Exporté pour être
// consommé par `shape-portal/ShapePortalManager.tsx`.
export const VSCodePortalContent = memo(
  function VSCodePortalContentImpl({ shape }: { shape: VSCodeShape }) {
    const editor = useEditor()
    const projects = useProjectStore((s) => s.projects)
    const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)

  const assignedProject = projects.find((p) => p.id === shape.props.projectId) ?? null

  // Bordure immersive unifiée : hover / sélection / fade 5 s / projet.
  // Cf. `src/renderer/src/lib/use-shape-border-state.ts` pour la logique.
  const borderState = useShapeBorderState(shape.id)
  const borderStyle = getShapeBorderStyle(borderState, assignedProject?.color ?? null)

  function setProjectId(projectId: string | null): void {
    editor.updateShape<VSCodeShape>({
      id: shape.id,
      type: 'vscode',
      props: { projectId }
    })
    setProjectDropdownOpen(false)
  }

  // Laisse tldraw recevoir pointer-down sur le conteneur global (sélection
  // de la shape) mais stoppe la propagation sur les éléments interactifs
  // du header pour permettre les clics locaux sur les boutons.
  const stopInteractive = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onTouchEnd: (e: React.TouchEvent) => e.stopPropagation()
  }

  return (
    <div
      style={{
        // Root du portail : `pointer-events: none` pour permettre le
        // drag tldraw via le header. Le click-glisser sur le header
        // passe à travers vers la shape tldraw sous-jacente qui reçoit
        // le pointer-down et démarre le drag. Les éléments interactifs
        // (boutons, dropdowns, iframe) surchargent explicitement en
        // `pointer-events: auto` ci-dessous.
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
        className="relative flex h-7 items-center justify-between border-b px-2 text-[11px] font-mono"
        style={{
          background: 'var(--bg-secondary, #101010)',
          borderColor: 'var(--border, #2a2a2a)',
          color: 'var(--fg-primary, #e5e5e5)',
          // Le header hérite `pointer-events: none` du root — le drag
          // shape tldraw passe à travers. Seuls les boutons interactifs
          // ont `pointer-events: auto` pour capter leurs propres clics.
          pointerEvents: 'none'
        }}
      >
        <span className="truncate">VSCode · {shape.props.folder || '(aucun dossier)'}</span>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-mono text-[10px] hover:bg-[var(--bg-tertiary)]"
            style={{
              color: assignedProject ? assignedProject.color : 'var(--fg-primary, #e5e5e5)',
              pointerEvents: 'auto'
            }}
            onClick={() => setProjectDropdownOpen((v) => !v)}
            title="Assigner à un projet"
            {...stopInteractive}
          >
            {assignedProject ? `● ${assignedProject.name}` : '○ aucun projet'}
          </button>
        </div>

        {projectDropdownOpen && (
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
                {...stopInteractive}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <span
                  className="flex-1 truncate"
                  style={{
                    color:
                      p.id === shape.props.projectId
                        ? p.color
                        : 'var(--fg-primary, #e5e5e5)',
                    fontWeight: p.id === shape.props.projectId ? 600 : 400
                  }}
                >
                  {p.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <VSCodeIframe folder={shape.props.folder} shapeId={shape.id} />
    </div>
  )
  },
  // Comparator strict : iframe VSCode unmountée si l'identité change.
  // Seuls `folder` et `id` déclenchent un remount ; projectId change juste
  // les couleurs (bord, badge). `w`/`h` retirés du comparator car le
  // portail gère déjà la taille via sa bounding box calculée.
  (prev, next) =>
    prev.shape.id === next.shape.id &&
    prev.shape.props.folder === next.shape.props.folder &&
    prev.shape.props.projectId === next.shape.props.projectId
)

function VSCodeIframe({ folder, shapeId }: { folder: string; shapeId: string }) {
  // Early return si aucun dossier : évite un setState dans l'effet (règle react-hooks/set-state-in-effect).
  if (!folder) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-4 text-center text-xs"
        style={{ color: 'var(--fg-muted, #9ca3af)' }}
      >
        Aucun dossier cible. Clic droit → assigner un dossier.
      </div>
    )
  }
  return <VSCodeIframeLoader folder={folder} shapeId={shapeId} />
}

function VSCodeIframeLoader({ folder, shapeId }: { folder: string; shapeId: string }) {
  const editor = useEditor()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.blow.vscode.openFolder(folder)
      if (cancelled) return
      if (!res.ok) {
        const base =
          res.reason === 'sidecar-indisponible'
            ? 'openvscode-server indisponible.'
            : 'Impossible d’ouvrir le dossier.'
        const detail = 'detail' in res && res.detail ? ` Détail : ${res.detail}` : ''
        setError(base + detail)
        return
      }
      setUrl(res.url)
    })()
    return () => {
      cancelled = true
    }
  }, [folder])

  if (error) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-4 text-center text-xs"
        style={{ color: 'var(--fg-muted, #9ca3af)' }}
      >
        {error}
      </div>
    )
  }

  if (!url) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-4 text-xs"
        style={{ color: 'var(--fg-muted, #9ca3af)' }}
      >
        Démarrage d’openvscode-server…
      </div>
    )
  }

  // `pointerEvents: 'auto'` : surcharge l'héritage `none` du root portail
  // afin que l'iframe soit interactive (clics, scroll dans VSCode web).
  // Le `stopPropagation` reste utile pour empêcher que le wheel/pointer
  // remontent au canvas tldraw (qui pourrait interpréter comme pan/zoom).
  return (
    <div
      className="flex-1"
      style={{ minHeight: 0, pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        // `stopPropagation` empêche tldraw de recevoir l'événement sur
        // cette zone wrapper (autour de l'iframe). La sélection / active
        // work est gérée par le listener global `window.pointerdown` de
        // `ShapePortalManager` (en capture phase, fire avant ce handler)
        // — on ne setSelectedShapes PAS ici, sinon on annule la
        // désélection du listener global et la bordure bleue tldraw
        // ré-apparaît après l'immersion. Le focus iframe déclenche de
        // toute façon `window.blur` → même chemin logique.
        e.stopPropagation()
      }}
      onPointerMove={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <iframe
        key={url}
        src={url}
        title="VSCode"
        className="border-0"
        style={{ width: '100%', height: '100%', background: '#000' }}
        sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
