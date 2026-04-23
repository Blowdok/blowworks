import { useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { AIModelT } from '@shared/ipc-contract.js'

interface ModelSelectorProps {
  models: AIModelT[]
  currentModelId: string
  loading: boolean
  onSelect: (modelId: string) => void
  onRefresh?: () => void
}

// Dropdown de sélection de modèle OpenRouter. Carte de chaque modèle
// affiche nom + prix input/output par 1M tokens + context window.
// Recherche fuzzy simple (includes insensible à la casse sur nom et id).
export default function ModelSelector({
  models,
  currentModelId,
  loading,
  onSelect,
  onRefresh
}: ModelSelectorProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  const current = models.find((m) => m.id === currentModelId)
  const label = current ? current.name : currentModelId

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    )
  }, [models, query])

  // Focus auto sur la recherche à l'ouverture du dropdown pour taper
  // immédiatement au clavier. Le reset de `query` est fait DANS les
  // handlers qui ferment le dropdown — pas ici — car un setState
  // synchronement dans un effet crée des cascades de re-render et
  // le lint `react-hooks/set-state-in-effect` le bloque.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  function closeDropdown(): void {
    setOpen(false)
    setQuery('')
  }

  // Fermeture au clic extérieur. Le dropdown étant porté vers document.body
  // (cf. createPortal plus bas), le test doit couvrir button + dropdown
  // séparément au lieu d'un simple `contains` sur un ancêtre commun.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      closeDropdown()
    }
    document.addEventListener('pointerdown', onDocClick)
    return () => document.removeEventListener('pointerdown', onDocClick)
  }, [open])

  // Reset du dropdownPos à la fermeture : pattern render-reset pour
  // éviter `react-hooks/set-state-in-effect` qui bloque setDropdownPos(null)
  // dans l'effet ci-dessous.
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open && dropdownPos !== null) setDropdownPos(null)
  }

  // Positionne le dropdown juste sous le bouton, aligné à droite. Recalculé
  // à l'ouverture ET au scroll/resize de la fenêtre — important car le
  // dropdown est portalisé (position fixe) et ne suit plus son ancêtre.
  useLayoutEffect(() => {
    if (!open) return
    function updatePos(): void {
      const btn = buttonRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const DROPDOWN_WIDTH = 360
      // Aligne le bord GAUCHE du dropdown avec le bord gauche du bouton :
      // le dropdown s'étend donc vers la droite (comportement formulaire
      // standard). Clamp au viewport pour éviter que le bord droit ne
      // sorte de l'écran si le bouton est à l'extrême droite.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - DROPDOWN_WIDTH - 8))
      const top = r.bottom + 4
      setDropdownPos({ top, left })
    }
    updatePos()
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true)
    return () => {
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className="relative"
      style={{ pointerEvents: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
        title={`Modèle actuel : ${currentModelId}`}
      >
        <span className="max-w-[180px] truncate">{label}</span>
        <span className="text-[9px]">▾</span>
      </button>
      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="flex w-[360px] flex-col overflow-hidden rounded-[var(--radius-md)] border shadow-2xl"
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            zIndex: 10000,
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border)',
            maxHeight: '50vh'
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
            <input
              ref={inputRef}
              type="text"
              placeholder="Rechercher un modèle…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
            />
            {onRefresh && (
              <button
                type="button"
                onClick={() => onRefresh()}
                disabled={loading}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] disabled:opacity-40"
                title="Rafraîchir la liste depuis OpenRouter"
              >
                {loading ? '…' : '⟳'}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="p-3 text-center text-[11px] text-[var(--fg-muted)]">
                {loading ? 'Chargement…' : 'Aucun modèle trouvé.'}
              </div>
            )}
            {filtered.map((m) => {
              const isCurrent = m.id === currentModelId
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onSelect(m.id)
                    closeDropdown()
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] hover:bg-[var(--bg-tertiary)]"
                  style={{
                    color: isCurrent ? 'var(--fg-secondary)' : 'var(--fg-primary)'
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{m.name}</span>
                    <span className="shrink-0 font-mono text-[9px] text-[var(--fg-muted)]">
                      {formatContextWindow(m.contextLength)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] text-[var(--fg-muted)]">
                    <span className="truncate font-mono">{m.id}</span>
                    <span className="shrink-0">
                      in {formatPricePerMillion(m.pricing.prompt)} / out{' '}
                      {formatPricePerMillion(m.pricing.completion)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// OpenRouter livre des prix au token (ex. 0.000003 = 3$/1M). On convertit
// et formate court : "$3.00/M" ou "$0.15/M".
function formatPricePerMillion(pricePerToken: number): string {
  if (pricePerToken === 0) return 'gratuit'
  const perM = pricePerToken * 1_000_000
  if (perM < 0.01) return '<$0.01/M'
  if (perM < 1) return `$${perM.toFixed(2)}/M`
  if (perM < 10) return `$${perM.toFixed(2)}/M`
  return `$${perM.toFixed(0)}/M`
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`
  return `${tokens} ctx`
}
