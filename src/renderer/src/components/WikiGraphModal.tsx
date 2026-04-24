import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownUrlTransform
} from '../lib/markdown.js'
import { applyMagneticSnap } from '../lib/magnetic-snap.js'
import type { WikiGraphDataT, WikiGraphNodeT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../stores/wiki-store.js'
import { linkifyWikiRefs } from './WikiPageViewer.js'

// Visualisation force-directed du graphe du wiki — side panel à gauche
// du canvas (default 50%, redimensionnable avec snap magnétique au
// centre). Laisse les shapes utilisateur visibles à droite. Simulation
// physique continue (pas 300 iters fixes — elle tourne TANT QUE le
// panneau est ouvert pour un rendu vivant), hover qui met en évidence
// les arêtes connectées, flèches directionnelles, ghost nodes pour les
// wikilinks orphelins.
//
// Algorithme : Fruchterman-Reingold simplifié + gravité + amortissement.
//   - Répulsion coulombienne entre tous les nœuds
//   - Attraction par ressort sur les arêtes (longueur de repos 120 px)
//   - Gravité douce vers le centre pour éviter la dérive
//   - Amortissement 0.85 par step, max-vitesse 8 px/step
// Stabilise en ~5 secondes puis le système reste en "doux mouvement".

interface WikiGraphModalProps {
  open: boolean
  onClose: () => void
}

const WIDTH = 1400
const HEIGHT = 900
const NODE_RADIUS_MIN = 7
const NODE_RADIUS_MAX = 28

// Couleurs par type YAML. Palette sobre, pas de violet (règle projet).
const TYPE_COLORS: Record<string, string> = {
  concept: '#22d3ee', // cyan
  connection: '#fbbf24', // amber
  qa: '#10b981', // émeraude
  projet: '#60a5fa', // bleu clair
  personne: '#f472b6', // rose
  outil: '#94a3b8', // slate
  décision: '#fb923c', // orange
  default: '#9ca3af'
}

// Types disponibles pour le filtre (couvre le seed wiki + ghost).
const ALL_TYPES = ['concept', 'connection', 'qa', 'projet', 'personne', 'outil', 'décision']

export default function WikiGraphModal({
  open,
  onClose
}: WikiGraphModalProps): React.ReactElement | null {
  const openWikiPage = useWikiStore((s) => s.openWikiPage)
  const setLeftPanelWidthFraction = useWikiStore((s) => s.setLeftPanelWidthFraction)
  const [data, setData] = useState<WikiGraphDataT | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set(ALL_TYPES))
  const [showOrphans, setShowOrphans] = useState(true)
  const [search, setSearch] = useState('')
  // Preview pane : si non-null, affiche l'aperçu de la page à gauche
  // et pousse le graph à droite en split 50/50. Navigation interne aux
  // wikilinks : met à jour cette valeur SANS fermer le graph.
  const [previewPageName, setPreviewPageName] = useState<string | null>(null)
  // Ref vers GraphCanvas pour appeler resetView/fitToView depuis le
  // menu ⋯ du header (dropdown compact ET boutons inline non-compact).
  const graphCanvasRef = useRef<GraphCanvasHandle>(null)

  // Largeur du side panel en fraction (0..1) de la zone canvas. Snap
  // magnétique à 50% via `applyMagneticSnap` — l'user peut dépasser
  // mais le panel "colle" au centre.
  const [widthFraction, setWidthFraction] = useState(0.5)
  const [resizing, setResizing] = useState(false)
  const [snapped, setSnapped] = useState(true)
  // Mode compact : sous 70% de largeur, les filtres par type vont dans
  // un menu "⋯" pour ne pas écraser le header. Au-delà, layout normal.
  const compactMode = widthFraction < 0.7
  const [filtersMenuOpen, setFiltersMenuOpen] = useState(false)
  // Recherche en compact : input caché derrière une icône 🔍, ouvert
  // dans un mini-popover sous le bouton (n'élargit pas le header).
  const [searchOpen, setSearchOpen] = useState(false)
  // Si on quitte le mode compact (étendu au-delà du seuil), on ferme
  // les menus déroulants qui n'ont plus de sens. Pattern render-reset.
  const [lastCompact, setLastCompact] = useState(compactMode)
  if (lastCompact !== compactMode) {
    setLastCompact(compactMode)
    if (!compactMode) {
      setFiltersMenuOpen(false)
      setSearchOpen(false)
    }
  }

  // Reset à l'ouverture (render-reset pour éviter setState-in-effect).
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (open) {
      setLoading(true)
      setError(null)
    }
  }

  // Publie la largeur courante au store dès que le graph est ouvert.
  useEffect(() => {
    if (!open) return
    setLeftPanelWidthFraction(widthFraction)
    return () => setLeftPanelWidthFraction(null)
  }, [open, widthFraction, setLeftPanelWidthFraction])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.blow.wiki
      .getGraph()
      .then((g) => {
        if (!cancelled) {
          setData(g as WikiGraphDataT)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  function toggleType(t: string): void {
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  if (!open) return null

  const mountTarget = document.getElementById('canvas-overlay-root') ?? document.body

  // Drag handle resize, snap magnétique au centre. Même logique que
  // WikiPageViewer.startResize (mutualisable mais inliné pour rester
  // local — le handle a son propre styling).
  function startResize(e: React.PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)
    const container = mountTarget
    let localSnapped = snapped
    function onMove(ev: PointerEvent): void {
      const rect = container.getBoundingClientRect()
      const frac = (ev.clientX - rect.left) / rect.width
      const clamped = Math.max(0.08, Math.min(0.95, frac))
      const result = applyMagneticSnap(clamped, localSnapped)
      localSnapped = result.snapped
      setWidthFraction(result.frac)
      setSnapped(result.snapped)
    }
    function onUp(): void {
      setResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return createPortal(
    <div
      className="pointer-events-auto absolute bottom-0 left-0 top-0 flex flex-col border-r shadow-2xl"
      role="dialog"
      aria-modal="false"
      style={{
        width: `${widthFraction * 100}%`,
        background: 'var(--bg-primary)',
        borderColor: 'var(--border)'
      }}
    >
      {/* Handle de resize : barre verticale à droite avec snap visuel cyan. */}
      <div
        onPointerDown={startResize}
        className="absolute bottom-0 right-0 top-0 z-10 w-[5px] cursor-col-resize hover:bg-[var(--fg-secondary)]"
        style={{
          background:
            snapped && resizing ? '#22d3ee' : resizing ? 'var(--fg-secondary)' : 'transparent',
          boxShadow: snapped && resizing ? '0 0 8px #22d3ee' : undefined,
          transition: resizing ? 'none' : 'background 120ms ease-out',
          transform: 'translateX(2px)'
        }}
        title={snapped ? 'Aimanté à 50% — tirer pour décoller' : 'Glisser pour redimensionner'}
      />
      <header
        className="relative flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <h2 className="shrink-0 text-[13px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
          Graphe
        </h2>
        {data && (
          <span className="shrink-0 truncate text-[10px] text-[var(--fg-muted)]">
            {data.nodes.length} nœuds · {data.edges.length} liens
          </span>
        )}

        {/* Recherche en mode large : input inline. En mode compact,
            l'input est caché — remplacé par une icône loupe à côté de ⋯. */}
        {!compactMode && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher…"
            className="ml-2 w-60 min-w-0 shrink rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
        )}

        {/* Spacer flex pour que les icônes restent collées à droite. */}
        {compactMode && <div className="min-w-0 flex-1" />}

        {/* Compact : icône loupe (toggle popover) + ⋯ filtres. */}
        {compactMode ? (
          <>
            <button
              type="button"
              onClick={() => {
                setSearchOpen((v) => !v)
                setFiltersMenuOpen(false)
              }}
              className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] leading-none text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
              title="Rechercher un nœud"
              aria-label="Rechercher"
              aria-expanded={searchOpen}
              style={{ background: search ? 'var(--bg-tertiary)' : 'transparent' }}
            >
              🔍
            </button>
            <button
              type="button"
              onClick={() => {
                setFiltersMenuOpen((v) => !v)
                setSearchOpen(false)
              }}
              className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] leading-none text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
              title="Filtres par type"
              aria-label="Filtres"
              aria-expanded={filtersMenuOpen}
            >
              ⋯
            </button>
          </>
        ) : (
          <div className="ml-2 flex flex-wrap items-center gap-1">
            {ALL_TYPES.map((t) => {
              const active = typeFilter.has(t)
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-opacity"
                  style={{
                    background: active ? 'var(--bg-tertiary)' : 'transparent',
                    color: active ? 'var(--fg-primary)' : 'var(--fg-muted)',
                    opacity: active ? 1 : 0.5,
                    border: `1px solid ${active ? TYPE_COLORS[t] : 'var(--border)'}`
                  }}
                  title={`${active ? 'Masquer' : 'Afficher'} les ${t}`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: TYPE_COLORS[t] }}
                  />
                  {t}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setShowOrphans((v) => !v)}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-opacity"
              style={{
                background: showOrphans ? 'var(--bg-tertiary)' : 'transparent',
                color: showOrphans ? 'var(--fg-primary)' : 'var(--fg-muted)',
                opacity: showOrphans ? 1 : 0.5,
                border: `1px dashed ${showOrphans ? '#ef4444' : 'var(--border)'}`
              }}
              title="Afficher les wikilinks brisés comme ghost nodes"
            >
              <span className="inline-block h-2 w-2 rounded-full border border-[#ef4444]" />
              orphelins
            </button>
          </div>
        )}

        {/* Boutons de vue (Fit / Reset zoom) visibles en mode non-compact.
            En mode compact ils sont groupés dans le dropdown ⋯. */}
        {!compactMode && (
          <>
            <button
              type="button"
              onClick={() => graphCanvasRef.current?.fitToView()}
              className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[11px] leading-none text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
              aria-label="Ajuster à l'écran"
              title="Ajuster à l'écran (recadre sur les nœuds visibles)"
            >
              ⊞
            </button>
            <button
              type="button"
              onClick={() => graphCanvasRef.current?.resetView()}
              className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[11px] leading-none text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
              aria-label="Réinitialiser le zoom"
              title="Réinitialiser le zoom (double-clic sur le vide fait pareil)"
            >
              ↺
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          className={`${compactMode ? '' : 'ml-auto'} shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[11px] leading-none text-[var(--fg-muted)] hover:text-[var(--fg-primary)]`}
          aria-label="Fermer"
          title="Fermer (Échap)"
        >
          ×
        </button>

        {/* Popover de recherche en mode compact. Auto-focus à l'ouverture. */}
        {compactMode && searchOpen && (
          <div
            className="absolute right-2 top-full z-20 mt-1 rounded-[var(--radius-sm)] border p-2 shadow-lg"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--bg-secondary)'
            }}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un nœud…"
              autoFocus
              className="w-56 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
            />
          </div>
        )}

        {/* Dropdown des filtres en mode compact. Positionné absolute sous
            le header — ne pousse pas le contenu, se ferme au clic ⋯ ou
            au resize hors compact. */}
        {compactMode && filtersMenuOpen && (
          <div
            className="absolute right-2 top-full z-20 mt-1 flex max-w-[260px] flex-wrap gap-1 rounded-[var(--radius-sm)] border p-2 shadow-lg"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--bg-secondary)'
            }}
          >
            {ALL_TYPES.map((t) => {
              const active = typeFilter.has(t)
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-opacity"
                  style={{
                    background: active ? 'var(--bg-tertiary)' : 'transparent',
                    color: active ? 'var(--fg-primary)' : 'var(--fg-muted)',
                    opacity: active ? 1 : 0.5,
                    border: `1px solid ${active ? TYPE_COLORS[t] : 'var(--border)'}`
                  }}
                  title={`${active ? 'Masquer' : 'Afficher'} les ${t}`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: TYPE_COLORS[t] }}
                  />
                  {t}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setShowOrphans((v) => !v)}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-opacity"
              style={{
                background: showOrphans ? 'var(--bg-tertiary)' : 'transparent',
                color: showOrphans ? 'var(--fg-primary)' : 'var(--fg-muted)',
                opacity: showOrphans ? 1 : 0.5,
                border: `1px dashed ${showOrphans ? '#ef4444' : 'var(--border)'}`
              }}
              title="Afficher les wikilinks brisés comme ghost nodes"
            >
              <span className="inline-block h-2 w-2 rounded-full border border-[#ef4444]" />
              orphelins
            </button>
            {/* Séparateur + actions de vue (zoom reset / fit). Groupées
                avec les filtres pour rester dans un seul dropdown ⋯. */}
            <div
              className="my-1 w-full border-t"
              style={{ borderColor: 'var(--border)' }}
              aria-hidden
            />
            <button
              type="button"
              onClick={() => {
                graphCanvasRef.current?.fitToView()
                setFiltersMenuOpen(false)
              }}
              className="w-full rounded-[var(--radius-sm)] px-2 py-1 text-left text-[10px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
              title="Recadrer sur les nœuds visibles"
            >
              ⊞ Ajuster à l&apos;écran
            </button>
            <button
              type="button"
              onClick={() => {
                graphCanvasRef.current?.resetView()
                setFiltersMenuOpen(false)
              }}
              className="w-full rounded-[var(--radius-sm)] px-2 py-1 text-left text-[10px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
              title="Revenir à la vue initiale"
            >
              ↺ Réinitialiser le zoom
            </button>
          </div>
        )}
      </header>

      <div className="relative flex-1 overflow-hidden">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[var(--fg-muted)]">
            Calcul du graphe…
          </div>
        )}
        {error && (
          <div
            className="absolute inset-0 flex items-center justify-center text-[12px]"
            style={{ color: '#f87171' }}
          >
            {error}
          </div>
        )}
        {!loading && !error && data && data.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[var(--fg-muted)]">
            Aucune page wiki à afficher. Lance le Wiki Builder pour alimenter la mémoire.
          </div>
        )}
        {!loading && !error && data && data.nodes.length > 0 && (
          <div className="flex h-full w-full">
            {previewPageName && (
              <div
                className="flex w-1/2 min-w-0 flex-col border-r"
                style={{ borderColor: 'var(--border)' }}
              >
                <PreviewPane
                  pageName={previewPageName}
                  onNavigate={(target) => setPreviewPageName(target)}
                  onClose={() => setPreviewPageName(null)}
                  onOpenInEditor={() => {
                    openWikiPage(previewPageName)
                    onClose()
                  }}
                />
              </div>
            )}
            <div className={previewPageName ? 'w-1/2 min-w-0' : 'h-full w-full'}>
              <GraphCanvas
                ref={graphCanvasRef}
                data={data}
                typeFilter={typeFilter}
                showOrphans={showOrphans}
                search={search}
                selectedNodeId={previewPageName}
                onNodeClick={(id) => {
                  // Ghost nodes (chemins commençant par ghost:) ne peuvent
                  // pas être ouverts — ils n'existent pas sur disque.
                  if (id.startsWith('ghost:')) return
                  // Clic nœud → ouvre (ou met à jour) le split aperçu.
                  setPreviewPageName(id)
                }}
              />
            </div>
          </div>
        )}
      </div>

      <footer
        className="flex shrink-0 items-center gap-3 border-t px-3 py-2 text-[10px] text-[var(--fg-muted)]"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        {compactMode ? (
          // En mode compact, légende minimaliste — un seul résumé.
          <span className="truncate">
            Molette : zoom · Drag vide : pan · Drag nœud : déplacer · 2× clic : reset
          </span>
        ) : (
          <>
            <span>
              <strong style={{ color: 'var(--fg-secondary)' }}>Taille</strong> ∝ backlinks ·
              <strong style={{ color: 'var(--fg-secondary)' }}> Contour blanc</strong> = pilier ·
              <strong style={{ color: '#ef4444' }}> ⬢ pointillés</strong> = orphelin
            </span>
            <span className="ml-auto">
              Molette : zoom · Drag vide : pan · Drag nœud : déplacer · 2× clic : reset
            </span>
          </>
        )}
      </footer>
    </div>,
    mountTarget
  )
}

// ──────────────────────────────────────────────────────────── GraphCanvas

interface SimNode {
  id: string
  title: string
  type: string
  importance: string
  statut: string
  backlinks: number
  outlinks: number
  isGhost: boolean
  x: number
  y: number
  vx: number
  vy: number
  hiddenByFilter: boolean
}

interface SimEdge {
  source: string
  target: string
  isGhost: boolean
}

// API exposée par GraphCanvas via ref : les contrôles de vue (reset,
// fit) sont appelés depuis le menu ⋯ du parent WikiGraphModal, qui
// n'a pas directement accès au state viewBox interne du canvas.
export interface GraphCanvasHandle {
  resetView: () => void
  fitToView: () => void
}

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

// Cap du zoom : de 0.1× (toute la scène + beaucoup de marge) jusqu'à
// 10× (très dézoomé sur un petit groupe de nœuds). Clamp appliqué sur
// l'échelle viewBox.w / WIDTH — plus petit = zoom IN, plus grand = OUT.
const MIN_VIEWBOX_SCALE = 0.1
const MAX_VIEWBOX_SCALE = 10
const ZOOM_STEP = 1.15

const GraphCanvas = forwardRef<
  GraphCanvasHandle,
  {
    data: WikiGraphDataT
    typeFilter: Set<string>
    showOrphans: boolean
    search: string
    selectedNodeId: string | null
    onNodeClick: (id: string) => void
  }
>(function GraphCanvas({ data, typeFilter, showOrphans, search, selectedNodeId, onNodeClick }, externalRef) {
  // ─────── Construction des nœuds incluant ghost nodes (orphelins)
  const { simNodes, simEdges } = useMemo(() => {
    // Map id → node pour lookup O(1)
    const nodeById = new Map<string, WikiGraphNodeT>()
    for (const n of data.nodes) nodeById.set(n.id, n)

    // Ghost nodes pour les wikilinks orphelins (target=null) si activés.
    const ghostIds = new Map<string, { id: string; slug: string; backlinks: number }>()
    const edges: SimEdge[] = []
    for (const e of data.edges) {
      if (e.target) {
        edges.push({ source: e.source, target: e.target, isGhost: false })
      } else if (showOrphans) {
        const ghostId = `ghost:${e.targetSlug}`
        const existing = ghostIds.get(ghostId) ?? {
          id: ghostId,
          slug: e.targetSlug,
          backlinks: 0
        }
        existing.backlinks++
        ghostIds.set(ghostId, existing)
        edges.push({ source: e.source, target: ghostId, isGhost: true })
      }
    }

    const cx = WIDTH / 2
    const cy = HEIGHT / 2

    // Génération déterministe stable : positions initiales en cercle,
    // pour que le graphe ne "saute" pas visuellement à chaque remount.
    const all = data.nodes.length + (showOrphans ? ghostIds.size : 0)

    const nodes: SimNode[] = []
    let idx = 0
    for (const n of data.nodes) {
      const angle = (2 * Math.PI * idx) / Math.max(1, all)
      const r = Math.min(WIDTH, HEIGHT) * 0.3
      nodes.push({
        id: n.id,
        title: n.title,
        type: n.type,
        importance: n.importance,
        statut: n.statut,
        backlinks: n.backlinks,
        outlinks: n.outlinks,
        isGhost: false,
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        hiddenByFilter: false
      })
      idx++
    }
    if (showOrphans) {
      for (const g of ghostIds.values()) {
        const angle = (2 * Math.PI * idx) / Math.max(1, all)
        const r = Math.min(WIDTH, HEIGHT) * 0.38
        nodes.push({
          id: g.id,
          title: g.slug,
          type: 'ghost',
          importance: 'standard',
          statut: 'missing',
          backlinks: g.backlinks,
          outlinks: 0,
          isGhost: true,
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
          vx: 0,
          vy: 0,
          hiddenByFilter: false
        })
        idx++
      }
    }

    return { simNodes: nodes, simEdges: edges }
  }, [data, showOrphans])

  const [nodes, setNodes] = useState<SimNode[]>(simNodes)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // ViewBox navigable : zoom (w, h) et pan (x, y). Valeur initiale =
  // vue complète de la scène. Toute interaction (molette, drag vide,
  // reset, fit) mute ce state ; le rendu SVG consomme viewBox via
  // l'attribut `viewBox="x y w h"`.
  const [viewBox, setViewBox] = useState<ViewBox>({ x: 0, y: 0, w: WIDTH, h: HEIGHT })
  // Pan en cours : coord initiale du pointer + viewBox au moment où
  // le pan a démarré. Null quand pas de pan actif.
  const panStateRef = useRef<{ startX: number; startY: number; vbX: number; vbY: number } | null>(
    null
  )
  // Miroir du ref ci-dessus pour les changements visuels déclenchés
  // pendant le pan (ex. cursor grabbing). Lire un ref pendant render
  // est interdit par les règles React — le state permet de re-render
  // proprement à chaque bascule pan ON/OFF.
  const [isPanning, setIsPanning] = useState(false)

  // Reset quand la géométrie change (ajout/retrait orphelins, nouvelles pages).
  const [lastDataKey, setLastDataKey] = useState({ simNodes, simEdges })
  if (lastDataKey.simNodes !== simNodes || lastDataKey.simEdges !== simEdges) {
    setLastDataKey({ simNodes, simEdges })
    setNodes(simNodes)
  }

  // ─────── Simulation continue via rAF, tant que le composant est monté.
  useEffect(() => {
    let running = true
    let rafId: number | null = null

    function tick(): void {
      if (!running) return
      setNodes((prev) => simulateStep(prev, simEdges, dragId))
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      running = false
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [simEdges, dragId])

  // ─────── Calculs dérivés pour rendu (visibilité, highlight)
  const maxBacklinks = Math.max(1, ...simNodes.map((n) => n.backlinks))
  const searchLower = search.trim().toLowerCase()

  // Un nœud est masqué si son type n'est pas dans le filtre (sauf ghost
  // qui est géré par `showOrphans` en amont).
  function isVisible(n: SimNode): boolean {
    if (n.isGhost) return showOrphans
    if (!typeFilter.has(n.type)) return false
    return true
  }

  function matchesSearch(n: SimNode): boolean {
    if (!searchLower) return true
    return n.title.toLowerCase().includes(searchLower) || n.id.toLowerCase().includes(searchLower)
  }

  // Set des arêtes liées au nœud survolé (pour highlighting).
  const connectedEdges = useMemo(() => {
    if (!hoverId) return new Set<number>()
    const s = new Set<number>()
    for (let i = 0; i < simEdges.length; i++) {
      const e = simEdges[i]
      if (e.source === hoverId || e.target === hoverId) s.add(i)
    }
    return s
  }, [hoverId, simEdges])

  // Set des nœuds liés au nœud survolé (pour highlighting).
  const connectedNodeIds = useMemo(() => {
    if (!hoverId) return new Set<string>()
    const s = new Set<string>([hoverId])
    for (const e of simEdges) {
      if (e.source === hoverId) s.add(e.target)
      if (e.target === hoverId) s.add(e.source)
    }
    return s
  }, [hoverId, simEdges])

  function nodeRadius(n: SimNode): number {
    const ratio = n.backlinks / maxBacklinks
    const base = NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * ratio
    return n.isGhost ? Math.max(NODE_RADIUS_MIN, base * 0.7) : base
  }

  function nodeColor(n: SimNode): string {
    if (n.isGhost) return '#ef4444'
    return TYPE_COLORS[n.type] ?? TYPE_COLORS.default
  }

  // Convertit clientX/Y en coords SVG en tenant compte du viewBox
  // courant (zoom/pan). Utilisé par le drag de nœud et le zoom molette
  // pour savoir quel point garder fixe sous le curseur.
  function svgCoords(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const x = viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.w
    const y = viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.h
    return { x, y }
  }

  // Met à jour la position pendant un drag ; clamp aux bords.
  function handleDrag(e: React.PointerEvent): void {
    if (panStateRef.current) {
      // Pan actif (drag sur le vide) : on translate le viewBox en
      // fonction du delta de pointer. 1 px écran = viewBox.w/rect.width
      // en coords SVG → la vue suit 1:1 le geste peu importe le zoom.
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const dx = ((e.clientX - panStateRef.current.startX) / rect.width) * viewBox.w
      const dy = ((e.clientY - panStateRef.current.startY) / rect.height) * viewBox.h
      setViewBox((vb) => ({
        ...vb,
        x: panStateRef.current!.vbX - dx,
        y: panStateRef.current!.vbY - dy
      }))
      return
    }
    if (!dragId) return
    const { x, y } = svgCoords(e.clientX, e.clientY)
    setNodes((prev) =>
      prev.map((n) =>
        n.id === dragId
          ? { ...n, x: clamp(x, 20, WIDTH - 20), y: clamp(y, 20, HEIGHT - 20), vx: 0, vy: 0 }
          : n
      )
    )
  }

  // Zoom molette centré sur le curseur. On calcule le point SVG sous
  // le curseur AVANT le zoom, on ajuste w/h par le facteur, puis on
  // translate x/y pour que ce même point reste sous le curseur.
  // `deltaY > 0` = wheel-down = zoom OUT (viewBox qui grandit).
  function handleWheel(e: React.WheelEvent<SVGSVGElement>): void {
    e.preventDefault()
    const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const ratioX = (e.clientX - rect.left) / rect.width
    const ratioY = (e.clientY - rect.top) / rect.height
    // Point SVG sous le curseur avant zoom
    const px = viewBox.x + ratioX * viewBox.w
    const py = viewBox.y + ratioY * viewBox.h
    // Nouvelle taille clampée
    const newW = clamp(viewBox.w * factor, WIDTH * MIN_VIEWBOX_SCALE, WIDTH * MAX_VIEWBOX_SCALE)
    const newH = clamp(viewBox.h * factor, HEIGHT * MIN_VIEWBOX_SCALE, HEIGHT * MAX_VIEWBOX_SCALE)
    // Nouvelle origine : garder px/py sous le curseur
    const newX = px - ratioX * newW
    const newY = py - ratioY * newH
    setViewBox({ x: newX, y: newY, w: newW, h: newH })
  }

  // Pan start sur le SVG : uniquement si la cible est le SVG lui-même
  // (background) et PAS un nœud ou une arête. Un clic sur un nœud
  // déclenche son propre stopPropagation qui empêche d'arriver ici.
  function handleSvgPointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    if (e.target !== e.currentTarget) return
    // Capturer le pointer pour recevoir pointermove/up même si le
    // curseur sort du SVG pendant le drag.
    e.currentTarget.setPointerCapture(e.pointerId)
    panStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      vbX: viewBox.x,
      vbY: viewBox.y
    }
    setIsPanning(true)
  }

  function handleSvgPointerUp(e: React.PointerEvent<SVGSVGElement>): void {
    if (panStateRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      panStateRef.current = null
      setIsPanning(false)
    }
    setDragId(null)
  }

  // Double-clic sur le vide du SVG = reset zoom (raccourci). Filtre
  // sur e.target === currentTarget comme pan, pour ne pas trigger
  // si l'user double-clique sur un nœud.
  function handleSvgDoubleClick(e: React.MouseEvent<SVGSVGElement>): void {
    if (e.target !== e.currentTarget) return
    setViewBox({ x: 0, y: 0, w: WIDTH, h: HEIGHT })
  }

  // Calcule la bounding box des nœuds visibles + padding, pour le
  // bouton "Fit to view". Filtre sur isVisible pour ne pas recadrer
  // sur des nœuds masqués par un filtre par type.
  function fitToVisibleNodes(): void {
    const visible = nodes.filter((n) => isVisible(n))
    if (visible.length === 0) {
      setViewBox({ x: 0, y: 0, w: WIDTH, h: HEIGHT })
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of visible) {
      const r = nodeRadius(n) + 12 // padding pour les labels
      if (n.x - r < minX) minX = n.x - r
      if (n.y - r < minY) minY = n.y - r
      if (n.x + r > maxX) maxX = n.x + r
      if (n.y + r > maxY) maxY = n.y + r
    }
    // Padding visuel supplémentaire autour de la bbox.
    const padX = (maxX - minX) * 0.08 + 20
    const padY = (maxY - minY) * 0.08 + 20
    const bboxW = maxX - minX + 2 * padX
    const bboxH = maxY - minY + 2 * padY
    // Préserve le ratio d'aspect WIDTH/HEIGHT du SVG : on prend la
    // plus grande des deux dimensions relatives comme référence.
    const aspect = WIDTH / HEIGHT
    const w = Math.max(bboxW, bboxH * aspect)
    const h = Math.max(bboxH, bboxW / aspect)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setViewBox({ x: cx - w / 2, y: cy - h / 2, w, h })
  }

  // Expose les actions de vue au parent via ref (menu ⋯).
  useImperativeHandle(
    externalRef,
    () => ({
      resetView: () => setViewBox({ x: 0, y: 0, w: WIDTH, h: HEIGHT }),
      fitToView: fitToVisibleNodes
    }),
    // fitToVisibleNodes dépend de nodes (closure) — l'imperative handle
    // est recréée à chaque changement, ce qui garantit que le parent
    // appelle toujours une version avec la liste de nœuds courante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, typeFilter, showOrphans]
  )

  const nodesById = new Map(nodes.map((n) => [n.id, n]))

  return (
    <svg
      ref={svgRef}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
      className="h-full w-full"
      style={{
        background: 'var(--bg-primary)',
        cursor: isPanning ? 'grabbing' : 'grab',
        // Empêche la sélection de texte pendant le pan.
        userSelect: 'none',
        WebkitUserSelect: 'none'
      }}
      onPointerDown={handleSvgPointerDown}
      onPointerMove={handleDrag}
      onPointerUp={handleSvgPointerUp}
      onPointerLeave={() => {
        panStateRef.current = null
        setIsPanning(false)
        setDragId(null)
      }}
      onWheel={handleWheel}
      onDoubleClick={handleSvgDoubleClick}
    >
      {/* Définitions : marker flèche pour arêtes, glow filter pour hover. */}
      <defs>
        <marker
          id="arrow-default"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)" />
        </marker>
        <marker
          id="arrow-highlight"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fg-secondary)" />
        </marker>
        <marker
          id="arrow-orphan"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#ef4444" fillOpacity="0.6" />
        </marker>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Arêtes — trait de base, surbrillance si connecté au hover. */}
      <g>
        {simEdges.map((edge, i) => {
          const src = nodesById.get(edge.source)
          const dst = nodesById.get(edge.target)
          if (!src || !dst) return null
          if (!isVisible(src) || !isVisible(dst)) return null

          const isHighlighted = connectedEdges.has(i)
          const isDimmed = hoverId !== null && !isHighlighted
          const color = edge.isGhost
            ? '#ef4444'
            : isHighlighted
              ? 'var(--fg-secondary)'
              : 'var(--border)'
          const opacity = edge.isGhost ? (isDimmed ? 0.2 : 0.5) : isDimmed ? 0.12 : 0.45
          const strokeWidth = isHighlighted ? 2 : 1

          // Raccourcit l'arête pour que la flèche ne soit pas masquée par
          // le nœud d'arrivée (marker refX=10 déjà pris en compte).
          const dx = dst.x - src.x
          const dy = dst.y - src.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const dstR = nodeRadius(dst) + 4
          const x2 = dst.x - (dx / dist) * dstR
          const y2 = dst.y - (dy / dist) * dstR
          const srcR = nodeRadius(src) + 2
          const x1 = src.x + (dx / dist) * srcR
          const y1 = src.y + (dy / dist) * srcR

          const markerId = edge.isGhost
            ? 'arrow-orphan'
            : isHighlighted
              ? 'arrow-highlight'
              : 'arrow-default'

          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={color}
              strokeOpacity={opacity}
              strokeWidth={strokeWidth}
              strokeDasharray={edge.isGhost ? '4,3' : undefined}
              markerEnd={`url(#${markerId})`}
              style={{ transition: 'stroke-width 120ms ease-out, stroke-opacity 120ms ease-out' }}
            />
          )
        })}
      </g>

      {/* Nœuds. */}
      <g>
        {nodes.map((n) => {
          if (!isVisible(n)) return null
          const r = nodeRadius(n)
          const color = nodeColor(n)
          const isHovered = n.id === hoverId
          const isSelected = n.id === selectedNodeId
          const isConnected = hoverId !== null && connectedNodeIds.has(n.id)
          const isDimmed = hoverId !== null && !isConnected
          const matchesFilterSearch = matchesSearch(n)
          // Recherche active : highlight les matches, dim le reste.
          const searchActive = searchLower.length > 0
          const isSearchMatch = searchActive && matchesFilterSearch
          const isSearchDimmed = searchActive && !matchesFilterSearch

          const finalOpacity = isSearchDimmed ? 0.2 : isDimmed ? 0.3 : 1
          const pulseOn = n.importance === 'pilier' && !isDimmed

          // Label affiché si : pilier, survolé, sélectionné en preview,
          // match de recherche, ou connecté au hover. Sinon caché pour
          // éviter le bruit visuel.
          const showLabel =
            isHovered ||
            isSelected ||
            isConnected ||
            isSearchMatch ||
            n.importance === 'pilier'

          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              style={{
                cursor: dragId === n.id ? 'grabbing' : n.isGhost ? 'not-allowed' : 'grab',
                opacity: finalOpacity,
                transition: 'opacity 140ms ease-out'
              }}
              onPointerDown={(e) => {
                e.stopPropagation()
                if (!n.isGhost) setDragId(n.id)
              }}
              onPointerEnter={() => setHoverId(n.id)}
              onPointerLeave={() => setHoverId((curr) => (curr === n.id ? null : curr))}
              onClick={(e) => {
                if (dragId) return
                e.stopPropagation()
                onNodeClick(n.id)
              }}
            >
              {/* Halo pour piliers + match recherche (glow SVG filter). */}
              {(pulseOn || isSearchMatch) && (
                <circle
                  r={r + 5}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.35}
                  strokeWidth={2}
                  style={{ animation: 'pulse 2.4s ease-in-out infinite' }}
                />
              )}
              {/* Anneau permanent pour le nœud ouvert dans l'aperçu. */}
              {isSelected && (
                <circle
                  r={r + 7}
                  fill="none"
                  stroke="white"
                  strokeOpacity={0.9}
                  strokeWidth={2}
                />
              )}
              <circle
                r={r}
                fill={color}
                fillOpacity={
                  n.statut === 'to-verify' || n.isGhost ? 0.5 : isHovered || isSelected ? 1 : 0.85
                }
                stroke={
                  n.importance === 'pilier' || isHovered || isSelected ? 'white' : 'transparent'
                }
                strokeWidth={n.importance === 'pilier' || isHovered || isSelected ? 2 : 0}
                strokeDasharray={n.isGhost ? '3,2' : undefined}
                filter={isHovered || isSelected ? 'url(#glow)' : undefined}
              />
              {showLabel && (
                <text
                  y={r + 13}
                  textAnchor="middle"
                  fontSize={isHovered ? 12 : 10}
                  fontWeight={n.importance === 'pilier' ? 600 : 400}
                  fill={n.isGhost ? '#f87171' : 'var(--fg-primary)'}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {n.title.length > 28 ? n.title.slice(0, 26) + '…' : n.title}
                </text>
              )}
              {/* Badge backlinks au hover */}
              {isHovered && n.backlinks > 0 && (
                <text
                  y={-(r + 6)}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--fg-muted)"
                  style={{ pointerEvents: 'none' }}
                >
                  ← {n.backlinks}
                </text>
              )}
            </g>
          )
        })}
      </g>

      {/* Keyframe pulse injecté inline pour que la modale soit self-contained. */}
      <style>
        {`@keyframes pulse {
          0%, 100% { stroke-opacity: 0.15; transform: scale(1); }
          50% { stroke-opacity: 0.5; transform: scale(1.08); }
        }`}
      </style>
    </svg>
  )
})

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ──────────────────────────────────────────────────────────── Simulation

// Un pas de simulation force-directed. Le nœud en cours de drag est
// "épinglé" (sa position est fixée par le pointer, pas modifiée par les
// forces). Fruchterman-Reingold simplifié + gravité vers centre.
function simulateStep(
  nodes: SimNode[],
  edges: SimEdge[],
  dragId: string | null
): SimNode[] {
  const REPULSION = 3500
  const SPRING_LENGTH = 130
  const SPRING_K = 0.025
  const DAMPING = 0.88
  const CENTER_PULL = 0.004
  const MAX_VELOCITY = 8

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const forces = new Map<string, { fx: number; fy: number }>()
  for (const n of nodes) forces.set(n.id, { fx: 0, fy: 0 })

  // Répulsion entre chaque paire (O(n²) — OK jusqu'à ~500 nœuds).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist2 = dx * dx + dy * dy + 1
      const dist = Math.sqrt(dist2)
      const force = REPULSION / dist2
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      forces.get(a.id)!.fx += fx
      forces.get(a.id)!.fy += fy
      forces.get(b.id)!.fx -= fx
      forces.get(b.id)!.fy -= fy
    }
  }

  // Attraction par les arêtes (ressort). Les arêtes orphelines ont une
  // attraction un peu plus faible pour que les ghosts flottent en
  // périphérie au lieu d'aspirer leurs sources vers le centre.
  for (const e of edges) {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) + 1
    const displacement = dist - SPRING_LENGTH
    const k = e.isGhost ? SPRING_K * 0.5 : SPRING_K
    const fx = (dx / dist) * displacement * k
    const fy = (dy / dist) * displacement * k
    forces.get(a.id)!.fx += fx
    forces.get(a.id)!.fy += fy
    forces.get(b.id)!.fx -= fx
    forces.get(b.id)!.fy -= fy
  }

  // Gravité vers le centre pour éviter la dérive du système.
  const cx = WIDTH / 2
  const cy = HEIGHT / 2
  for (const n of nodes) {
    forces.get(n.id)!.fx += (cx - n.x) * CENTER_PULL
    forces.get(n.id)!.fy += (cy - n.y) * CENTER_PULL
  }

  return nodes.map((n) => {
    // Nœud en cours de drag : pas de physique, position écrasée par le pointer.
    if (n.id === dragId) return n
    const f = forces.get(n.id)!
    const vx = (n.vx + f.fx * 0.015) * DAMPING
    const vy = (n.vy + f.fy * 0.015) * DAMPING
    const clampedVx = clamp(vx, -MAX_VELOCITY, MAX_VELOCITY)
    const clampedVy = clamp(vy, -MAX_VELOCITY, MAX_VELOCITY)
    return {
      ...n,
      vx: clampedVx,
      vy: clampedVy,
      x: clamp(n.x + clampedVx, 20, WIDTH - 20),
      y: clamp(n.y + clampedVy, 20, HEIGHT - 20)
    }
  })
}

// ──────────────────────────────────────────────────────────── PreviewPane

// Aperçu markdown à gauche quand un nœud du graph est cliqué. Lecture
// seule — pour éditer, bouton ✎ qui ouvre le WikiPageViewer complet
// (et ferme le graph). Les wikilinks cliquables dedans naviguent
// EN INTERNE (update `previewPageName`), pas d'ouverture d'un autre
// viewer. Résultat : exploration fluide wikilinks ↔ graph côte à côte.
function PreviewPane({
  pageName,
  onNavigate,
  onClose,
  onOpenInEditor
}: {
  pageName: string
  onNavigate: (target: string) => void
  onClose: () => void
  onOpenInEditor: () => void
}): React.ReactElement {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Pattern render-reset pour éviter setState-in-effect.
  const [lastName, setLastName] = useState(pageName)
  if (lastName !== pageName) {
    setLastName(pageName)
    setContent(null)
    setError(null)
  }

  useEffect(() => {
    let cancelled = false
    window.blow.wiki
      .readWiki(pageName)
      .then((c) => {
        if (!cancelled) setContent(c as string)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [pageName])

  const rendered = useMemo(() => {
    if (content === null) return null
    return (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={markdownUrlTransform}
        components={{
          a: ({ children, href, ...rest }) => {
            if (href && href.startsWith('wiki-page://')) {
              const target = href.slice('wiki-page://'.length)
              return (
                <a
                  {...rest}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    // Navigation INTERNE : ne ferme pas le graph,
                    // met juste à jour le panneau preview.
                    onNavigate(target)
                  }}
                  style={{
                    color: 'var(--fg-secondary)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textDecorationStyle: 'dashed',
                    textUnderlineOffset: '3px'
                  }}
                  title={`Naviguer vers wiki/${target}`}
                >
                  {children}
                </a>
              )
            }
            return (
              <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {linkifyWikiRefs(content)}
      </ReactMarkdown>
    )
  }, [content, onNavigate])

  return (
    <>
      <header
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <button
          type="button"
          onClick={onClose}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
          title="Fermer l'aperçu (retour full graph)"
          aria-label="Fermer l'aperçu"
        >
          ×
        </button>
        <code className="flex-1 truncate text-[11px] text-[var(--fg-muted)]">
          wiki/{pageName}
        </code>
        <button
          type="button"
          onClick={onOpenInEditor}
          className="rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-medium"
          style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          title="Ouvrir en édition (ferme le graph)"
        >
          ✎ Éditer
        </button>
      </header>
      <div
        className="flex-1 overflow-y-auto px-5 py-4 text-[13px]"
        style={{ color: 'var(--fg-primary)', background: 'var(--bg-secondary)' }}
      >
        {error && (
          <div className="text-[11px]" style={{ color: '#f87171' }}>
            {error}
          </div>
        )}
        {!error && content === null && (
          <div className="text-[11px] text-[var(--fg-muted)]">Chargement…</div>
        )}
        {content !== null && <div className="markdown-body">{rendered}</div>}
      </div>
    </>
  )
}
