import { useEffect, useMemo, useRef, useState } from 'react'
import type { AIConversationSummaryT } from '@shared/ipc-contract.js'

interface ConversationHistoryDropdownProps {
  open: boolean
  onToggle: () => void
  onClose: () => void
  currentConversationId: string
  conversations: Map<string, AIConversationSummaryT>
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

// Dropdown historique des conversations accessibles à la ChatShape courante.
// Alimenté par `chat-store.allConversations` (hydraté via `ai.listConversations`).
// La liste est triée par `updatedAt DESC` et filtrable côté client par titre.
// La suppression est confirmée via un double-clic sur l'icône 🗑 pour éviter
// les mauvaises manipulations — modèle volontairement léger, pas de modale.
export default function ConversationHistoryDropdown({
  open,
  onToggle,
  onClose,
  currentConversationId,
  conversations,
  onSelect,
  onDelete
}: ConversationHistoryDropdownProps): React.ReactElement {
  const [query, setQuery] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const sorted = useMemo(() => {
    const list = Array.from(conversations.values())
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list
  }, [conversations])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter((c) => {
      const title = c.title || 'Nouvelle conversation'
      return title.toLowerCase().includes(q) || c.model.toLowerCase().includes(q)
    })
  }, [sorted, query])

  // Reset query + pendingDelete quand le dropdown se ferme — via le pattern
  // React 18 « reset state during render » au lieu d'un setState dans effet
  // (qui cascade les renders et est flaggé par react-hooks/set-state-in-effect).
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open) {
      setQuery('')
      setPendingDeleteId(null)
    }
  }

  // Focus auto sur la recherche à l'ouverture — effet purement DOM (pas de
  // setState), donc légitime.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  // Fermeture sur clic extérieur.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDocPointerDown(e: PointerEvent): void {
      if (!rootRef.current) return
      if (e.target instanceof Node && rootRef.current.contains(e.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [open, onClose])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)]"
        title={`Historique (${conversations.size} conversation${conversations.size > 1 ? 's' : ''})`}
        aria-label="Historique des conversations"
      >
        ⏱ {conversations.size}
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-10 flex max-h-[360px] w-[280px] flex-col overflow-hidden rounded border text-[11px] shadow-lg"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border)'
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="shrink-0 border-b p-1.5" style={{ borderColor: 'var(--border)' }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher…"
              className="w-full rounded border bg-[var(--bg-primary)] px-2 py-1 text-[11px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
              style={{ borderColor: 'var(--border)' }}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[10px] text-[var(--fg-muted)]">
                {query.trim()
                  ? 'Aucune conversation ne correspond.'
                  : 'Aucune conversation pour l’instant.'}
              </div>
            )}
            {filtered.map((c) => {
              const isActive = c.id === currentConversationId
              const isPendingDelete = c.id === pendingDeleteId
              const title = c.title || 'Nouvelle conversation'
              return (
                <div
                  key={c.id}
                  className={`group flex items-start gap-1.5 border-b px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)] ${
                    isActive ? 'bg-[var(--bg-tertiary)]' : ''
                  }`}
                  style={{ borderColor: 'var(--border)' }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <span
                      className="truncate text-[11px]"
                      style={{
                        color: isActive ? 'var(--fg-primary)' : 'var(--fg-secondary)',
                        fontWeight: isActive ? 600 : 400
                      }}
                    >
                      {title}
                    </span>
                    <span className="truncate text-[9px] text-[var(--fg-muted)]">
                      {c.messagesCount} msg · {formatRelative(c.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (isPendingDelete) {
                        onDelete(c.id)
                        setPendingDeleteId(null)
                      } else {
                        setPendingDeleteId(c.id)
                      }
                    }}
                    onBlur={() => setPendingDeleteId(null)}
                    className="shrink-0 rounded px-1 text-[10px] opacity-0 transition-opacity hover:bg-[var(--bg-primary)] group-hover:opacity-100"
                    style={{
                      color: isPendingDelete ? '#ef4444' : 'var(--fg-muted)',
                      opacity: isPendingDelete ? 1 : undefined
                    }}
                    title={isPendingDelete ? 'Confirmer la suppression' : 'Supprimer cette conversation'}
                  >
                    {isPendingDelete ? '✓ confirmer' : '🗑'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// Formate un timestamp en libellé relatif court ("à l'instant", "il y a 5 min",
// "il y a 2 h", "il y a 3 j", sinon date courte). Tolère les clocks
// légèrement en avance en bornant à "à l'instant".
function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.max(0, Math.floor(diff / 1000))
  if (s < 60) return 'à l’instant'
  const m = Math.floor(s / 60)
  if (m < 60) return `il y a ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `il y a ${h} h`
  const d = Math.floor(h / 24)
  if (d < 30) return `il y a ${d} j`
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
}
