import { useEffect, useMemo, useState } from 'react'
import type { WikiEntryT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../stores/wiki-store.js'

// Explorateur wiki plein cadre dans la sidebar. Remplace le contenu
// standard (Projets + Mémoire + Graph) quand `sidebarMode === 'wiki-explorer'`.
// Propres scrollbars internes → ne pousse pas le footer hors écran.
//
// Arborescence : regroupée par dossier de 1er niveau. Clic sur une page
// → `openWikiPage(name)` dans le store → `WikiPageViewer` global affiche
// la modale. Pas de rename/create/delete inline (ces actions passent
// par les tools IA confirmés, pattern Sprint 2).

interface WikiExplorerSidebarProps {
  collapsed: boolean
}

export default function WikiExplorerSidebar({
  collapsed
}: WikiExplorerSidebarProps): React.ReactElement {
  const status = useWikiStore((s) => s.status)
  const setSidebarMode = useWikiStore((s) => s.setSidebarMode)
  const openWikiPage = useWikiStore((s) => s.openWikiPage)

  const [entries, setEntries] = useState<WikiEntryT[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  // Re-fetch quand le statut change (wikiCount, initialized). Pattern
  // render-reset pour `loading: true` : sinon le linter bloque le
  // setState en tête d'effet.
  const [lastCount, setLastCount] = useState(status.wikiCount)
  if (lastCount !== status.wikiCount) {
    setLastCount(status.wikiCount)
    if (status.initialized) setLoading(true)
  }

  useEffect(() => {
    if (!status.initialized) return
    let cancelled = false
    window.blow.wiki
      .listWiki()
      .then((list) => {
        if (!cancelled) {
          setEntries(list as WikiEntryT[])
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([])
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [status.initialized, status.wikiCount])

  // Groupage par dossier 1er niveau. Pages racine → groupe "(racine)".
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = q
      ? entries.filter((e) => e.name.toLowerCase().includes(q))
      : entries
    const m = new Map<string, WikiEntryT[]>()
    for (const e of filtered) {
      const slash = e.name.indexOf('/')
      const key = slash === -1 ? '(racine)' : e.name.slice(0, slash)
      const arr = m.get(key) ?? []
      arr.push(e)
      m.set(key, arr)
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [entries, filter])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header
        className="flex shrink-0 items-center gap-2 border-b px-3 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setSidebarMode('standard')}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
          title="Retour à la sidebar standard"
          aria-label="Retour"
        >
          ←
        </button>
        {!collapsed && (
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
            Explorateur wiki
          </h2>
        )}
      </header>

      {!collapsed && (
        <div
          className="shrink-0 border-b px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer…"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--fg-muted)]">
            <span>
              {entries.length} page{entries.length > 1 ? 's' : ''} · {status.rawCount} raw
            </span>
            {loading && <span>⏳</span>}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {entries.length === 0 && !loading && (
          <span className="text-[10px] text-[var(--fg-muted)]">
            {collapsed ? '' : 'Aucune page compilée. Utilise le chat + ✦ dans la section Mémoire pour construire le wiki.'}
          </span>
        )}
        {!collapsed && (
          <div className="flex flex-col gap-2">
            {groups.map(([dir, items]) => (
              <details key={dir} open className="text-[11px]">
                <summary className="cursor-pointer list-none text-[10px] uppercase tracking-wider text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]">
                  {dir}/ <span className="normal-case">({items.length})</span>
                </summary>
                <div className="mt-1 flex flex-col">
                  {items.map((e) => {
                    const basename = e.name.slice(e.name.lastIndexOf('/') + 1)
                    return (
                      <button
                        key={e.name}
                        type="button"
                        onClick={() => openWikiPage(e.name)}
                        className="truncate rounded-[var(--radius-sm)] px-2 py-0.5 text-left text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
                        title={`Ouvrir wiki/${e.name}`}
                      >
                        {basename.replace(/\.md$/, '')}
                      </button>
                    )
                  })}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
