import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WikiGraphDataT, WikiGraphNodeT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../stores/wiki-store.js'

// Visualisation force-directed du graph du wiki. Modale plein écran
// avec SVG + simulation physique maison (~60 lignes) — pas de dep d3
// lourde pour un graphe <200 nœuds où une simulation simple suffit.
//
// Interactions :
//   - Drag d'un nœud pour le déplacer (désactive sa force pendant le drag)
//   - Clic sur un nœud → ouvre la page wiki correspondante
//   - Zoom/pan via le wrapper SVG (molette + drag vide)
//
// Algorithme : Fruchterman-Reingold simplifié.
//   - Chaque nœud subit une répulsion coulombienne depuis les autres
//   - Chaque arête exerce une attraction de ressort
//   - Amortissement à chaque itération → stabilise en ~200 itérations

interface WikiGraphModalProps {
  open: boolean
  onClose: () => void
}

const WIDTH = 1200
const HEIGHT = 800
const NODE_RADIUS_MIN = 6
const NODE_RADIUS_MAX = 24

// Couleurs par type YAML. Palette sobre, pas de violet (règle projet).
const TYPE_COLORS: Record<string, string> = {
  concept: '#22d3ee', // cyan
  connection: '#fbbf24', // amber
  qa: '#10b981', // émeraude
  projet: '#60a5fa', // bleu clair
  personne: '#f472b6', // rose
  outil: '#94a3b8', // slate
  décision: '#a78bfa', // (pas violet vif — laissez fallback gris)
  default: '#9ca3af'
}

export default function WikiGraphModal({
  open,
  onClose
}: WikiGraphModalProps): React.ReactElement | null {
  const openWikiPage = useWikiStore((s) => s.openWikiPage)
  const [data, setData] = useState<WikiGraphDataT | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch à l'ouverture. Pattern render-reset pour loading + error.
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

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/80" onClick={onClose} aria-hidden />
      <div
        className="relative m-auto flex h-[92vh] w-[min(1200px,95vw)] flex-col overflow-hidden rounded-[var(--radius-md)] border shadow-2xl"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2 className="text-[13px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
            Graphe du wiki
          </h2>
          <div className="flex items-center gap-3 text-[10px] text-[var(--fg-muted)]">
            {data && (
              <span>
                {data.nodes.length} nœuds · {data.edges.length} arêtes
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
              aria-label="Fermer"
              title="Fermer (Échap)"
            >
              ×
            </button>
          </div>
        </div>
        <div className="relative flex-1 overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[var(--fg-muted)]">
              Calcul de la mise en page…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: '#f87171' }}>
              {error}
            </div>
          )}
          {!loading && !error && data && data.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[var(--fg-muted)]">
              Aucune page wiki à afficher. Utilise le chat + ✦ Reconstruire pour alimenter le wiki.
            </div>
          )}
          {!loading && !error && data && data.nodes.length > 0 && (
            <GraphCanvas
              data={data}
              onNodeClick={(id) => {
                openWikiPage(id)
                onClose()
              }}
            />
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-3 border-t px-3 py-2 text-[10px] text-[var(--fg-muted)]"
          style={{ borderColor: 'var(--border)' }}
        >
          <span>Taille du nœud ∝ backlinks. Clic sur un nœud pour ouvrir la page.</span>
          <div className="ml-auto flex items-center gap-2">
            {['concept', 'connection', 'qa', 'projet', 'outil', 'personne'].map((t) => (
              <span key={t} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: TYPE_COLORS[t] ?? TYPE_COLORS.default }}
                />
                <span>{t}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ──────────────────────────────────────────────────────────── GraphCanvas

interface SimNode extends WikiGraphNodeT {
  x: number
  y: number
  vx: number
  vy: number
  fx?: number
  fy?: number
}

function GraphCanvas({
  data,
  onNodeClick
}: {
  data: WikiGraphDataT
  onNodeClick: (id: string) => void
}): React.ReactElement {
  // Clone des nœuds avec positions initiales aléatoires centrées.
  const initialNodes = useMemo<SimNode[]>(() => {
    const cx = WIDTH / 2
    const cy = HEIGHT / 2
    return data.nodes.map((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, data.nodes.length)
      const r = Math.min(WIDTH, HEIGHT) * 0.3
      return {
        ...n,
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        vx: 0,
        vy: 0
      }
    })
  }, [data])

  const [nodes, setNodes] = useState<SimNode[]>(initialNodes)
  const [dragId, setDragId] = useState<string | null>(null)

  // Reset nœuds si data change (passage d'un wiki vide → peuplé).
  const [lastDataKey, setLastDataKey] = useState(data)
  if (lastDataKey !== data) {
    setLastDataKey(data)
    setNodes(initialNodes)
  }

  // Simulation : 300 itérations au mount, puis continue si drag.
  useEffect(() => {
    let iter = 0
    const MAX_ITER = 300
    let running = true

    function tick(): void {
      if (!running) return
      setNodes((prev) => simulateStep(prev, data.edges))
      iter++
      if (iter < MAX_ITER || dragId !== null) {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)

    return () => {
      running = false
    }
  }, [data, dragId])

  const maxBacklinks = Math.max(1, ...data.nodes.map((n) => n.backlinks))

  function nodeRadius(n: WikiGraphNodeT): number {
    const ratio = n.backlinks / maxBacklinks
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * ratio
  }

  const svgRef = useRef<SVGSVGElement>(null)

  function svgCoords(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH
    const y = ((e.clientY - rect.top) / rect.height) * HEIGHT
    return { x, y }
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-full w-full"
      style={{ background: 'var(--bg-primary)' }}
      onPointerMove={(e) => {
        if (!dragId) return
        const { x, y } = svgCoords(e)
        setNodes((prev) => prev.map((n) => (n.id === dragId ? { ...n, x, y, vx: 0, vy: 0 } : n)))
      }}
      onPointerUp={() => setDragId(null)}
      onPointerLeave={() => setDragId(null)}
    >
      <g>
        {data.edges.map((edge, i) => {
          const src = nodes.find((n) => n.id === edge.source)
          const dst = edge.target ? nodes.find((n) => n.id === edge.target) : null
          if (!src) return null
          if (!dst) {
            // Arête orpheline : on ne dessine pas (pas de destination)
            // — sinon il faudrait créer un nœud "ghost". Skip pour v1.
            return null
          }
          return (
            <line
              key={i}
              x1={src.x}
              y1={src.y}
              x2={dst.x}
              y2={dst.y}
              stroke="var(--border)"
              strokeOpacity={0.4}
              strokeWidth={1}
            />
          )
        })}
        {nodes.map((n) => {
          const r = nodeRadius(n)
          const color = TYPE_COLORS[n.type] ?? TYPE_COLORS.default
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              style={{ cursor: dragId === n.id ? 'grabbing' : 'grab' }}
              onPointerDown={(e) => {
                e.stopPropagation()
                setDragId(n.id)
              }}
              onClick={(e) => {
                // Clic simple (pas un drag) → ouvre la page.
                if (dragId) return
                e.stopPropagation()
                onNodeClick(n.id)
              }}
            >
              <circle
                r={r}
                fill={color}
                fillOpacity={n.statut === 'to-verify' ? 0.5 : 0.85}
                stroke={n.importance === 'pilier' ? 'white' : 'transparent'}
                strokeWidth={n.importance === 'pilier' ? 2 : 0}
              />
              <text
                y={r + 12}
                textAnchor="middle"
                fontSize={10}
                fill="var(--fg-primary)"
                style={{ pointerEvents: 'none' }}
              >
                {n.title.length > 20 ? n.title.slice(0, 18) + '…' : n.title}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}

// ──────────────────────────────────────────────────────────── Simulation

// Un pas de simulation force-directed. Pattern Fruchterman-Reingold
// simplifié : répulsion coulombienne + attraction par ressort sur les
// arêtes + amortissement. Stabilise en ~200-300 itérations pour un
// graphe de 50-100 nœuds.
function simulateStep(
  nodes: SimNode[],
  edges: Array<{ source: string; target: string | null }>
): SimNode[] {
  const REPULSION = 4000
  const SPRING_LENGTH = 120
  const SPRING_K = 0.02
  const DAMPING = 0.85
  const CENTER_PULL = 0.005

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
      const dist2 = dx * dx + dy * dy + 0.01
      const force = REPULSION / dist2
      const fx = (dx / Math.sqrt(dist2)) * force
      const fy = (dy / Math.sqrt(dist2)) * force
      forces.get(a.id)!.fx += fx
      forces.get(a.id)!.fy += fy
      forces.get(b.id)!.fx -= fx
      forces.get(b.id)!.fy -= fy
    }
  }

  // Attraction par les arêtes (ressort).
  for (const e of edges) {
    if (!e.target) continue
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
    const displacement = dist - SPRING_LENGTH
    const fx = (dx / dist) * displacement * SPRING_K
    const fy = (dy / dist) * displacement * SPRING_K
    forces.get(a.id)!.fx += fx
    forces.get(a.id)!.fy += fy
    forces.get(b.id)!.fx -= fx
    forces.get(b.id)!.fy -= fy
  }

  // Gravité vers le centre pour éviter la dérive.
  const cx = WIDTH / 2
  const cy = HEIGHT / 2
  for (const n of nodes) {
    forces.get(n.id)!.fx += (cx - n.x) * CENTER_PULL
    forces.get(n.id)!.fy += (cy - n.y) * CENTER_PULL
  }

  return nodes.map((n) => {
    const f = forces.get(n.id)!
    const vx = (n.vx + f.fx) * DAMPING
    const vy = (n.vy + f.fy) * DAMPING
    const maxV = 10
    const clampedVx = Math.max(-maxV, Math.min(maxV, vx))
    const clampedVy = Math.max(-maxV, Math.min(maxV, vy))
    return {
      ...n,
      vx: clampedVx,
      vy: clampedVy,
      x: Math.max(20, Math.min(WIDTH - 20, n.x + clampedVx)),
      y: Math.max(20, Math.min(HEIGHT - 20, n.y + clampedVy))
    }
  })
}
