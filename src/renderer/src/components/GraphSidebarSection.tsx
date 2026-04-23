import { useWikiStore } from '../stores/wiki-store.js'

// Section « Graph » de la Sidebar — bouton qui ouvre la modale de
// visualisation force-directed du graphe wiki (WikiGraphModal).
//
// Le placeholder Sprint 3 est remplacé par le vrai graph maintenant
// qu'on a le service `buildWikiGraphData` côté main + la modale SVG
// avec simulation physique maison.

interface GraphSidebarSectionProps {
  collapsed: boolean
}

export default function GraphSidebarSection({
  collapsed
}: GraphSidebarSectionProps): React.ReactElement {
  const status = useWikiStore((s) => s.status)
  const setGraphOpen = useWikiStore((s) => s.setGraphOpen)

  const isConfigured = status.folderPath != null && status.initialized

  if (collapsed) {
    return (
      <div className="flex justify-center px-2">
        <button
          type="button"
          disabled={!isConfigured}
          onClick={() => setGraphOpen(true)}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
          title={isConfigured ? 'Ouvrir le graph du wiki' : 'Wiki non configuré'}
        >
          ⬡
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
          Graph
        </h3>
      </div>
      <div className="flex flex-col gap-1.5">
        {!isConfigured && (
          <span className="text-[10px] text-[var(--fg-muted)]">
            Wiki non configuré.
          </span>
        )}
        {isConfigured && (
          <>
            <span className="text-[10px] text-[var(--fg-muted)]">
              {status.wikiCount} nœud{status.wikiCount > 1 ? 's' : ''} wiki connecté{status.wikiCount > 1 ? 's' : ''} par les \`[[liens]]\`.
            </span>
            <button
              type="button"
              onClick={() => setGraphOpen(true)}
              disabled={status.wikiCount === 0}
              className="rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}
              title={
                status.wikiCount === 0
                  ? 'Aucune page à visualiser — lance le Wiki Builder'
                  : 'Visualiser le graphe des wikilinks'
              }
            >
              ⬡ Ouvrir le graph
            </button>
          </>
        )}
      </div>
    </div>
  )
}
