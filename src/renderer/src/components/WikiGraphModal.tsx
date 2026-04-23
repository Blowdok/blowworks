import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownUrlTransform
} from '../lib/markdown.js'
import type { WikiGraphDataT, WikiGraphNodeT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../stores/wiki-store.js'
import { linkifyWikiRefs } from './WikiPageViewer.js'

// Visualisation force-directed du graphe du wiki — panneau plein cadre
// qui remplace le canvas. Simulation physique continue (pas 300 iters
// fixes — elle tourne TANT QUE le panneau est ouvert pour un rendu
// vivant), hover qui met en évidence les arêtes connectées, flèches
// directionnelles, ghost nodes pour les wikilinks orphelins.
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

  // Reset à l'ouverture (render-reset pour éviter setState-in-effect).
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (open) {
      setLoading(true)
      setError(null)
    }
  }

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

  return createPortal(
    <div
      className="pointer-events-auto absolute inset-0 flex flex-col"
      role="dialog"
      aria-modal="false"
      style={{ background: 'var(--bg-primary)' }}
    >
      <header
        className="flex shrink-0 items-center gap-3 border-b px-3 py-2"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <h2 className="text-[13px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
          Graphe du wiki
        </h2>
        {data && (
          <span className="text-[10px] text-[var(--fg-muted)]">
            {data.nodes.length} nœuds · {data.edges.length} liens
          </span>
        )}

        {/* Recherche */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher un nœud…"
          className="ml-4 w-60 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
        />

        {/* Filtre par type */}
        <div className="ml-2 flex items-center gap-1">
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

        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
          aria-label="Fermer"
          title="Fermer (Échap)"
        >
          × Fermer
        </button>
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
        <span>
          <strong style={{ color: 'var(--fg-secondary)' }}>Taille</strong> ∝ backlinks ·
          <strong style={{ color: 'var(--fg-secondary)' }}> Contour blanc</strong> = pilier ·
          <strong style={{ color: '#ef4444' }}> ⬢ pointillés</strong> = orphelin
        </span>
        <span className="ml-auto">Survol : met en évidence les liens · Drag : déplacer · Clic : ouvrir la page</span>
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

function GraphCanvas({
  data,
  typeFilter,
  showOrphans,
  search,
  selectedNodeId,
  onNodeClick
}: {
  data: WikiGraphDataT
  typeFilter: Set<string>
  showOrphans: boolean
  search: string
  selectedNodeId: string | null
  onNodeClick: (id: string) => void
}): React.ReactElement {
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

  function svgCoords(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH
    const y = ((e.clientY - rect.top) / rect.height) * HEIGHT
    return { x, y }
  }

  // Met à jour la position pendant un drag ; clamp aux bords.
  function handleDrag(e: React.PointerEvent): void {
    if (!dragId) return
    const { x, y } = svgCoords(e)
    setNodes((prev) =>
      prev.map((n) =>
        n.id === dragId
          ? { ...n, x: clamp(x, 20, WIDTH - 20), y: clamp(y, 20, HEIGHT - 20), vx: 0, vy: 0 }
          : n
      )
    )
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]))

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-full w-full"
      style={{ background: 'var(--bg-primary)' }}
      onPointerMove={handleDrag}
      onPointerUp={() => setDragId(null)}
      onPointerLeave={() => setDragId(null)}
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
}

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
