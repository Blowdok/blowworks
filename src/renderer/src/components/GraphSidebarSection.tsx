// Section « Graph » de la Sidebar — placeholder pour le futur graphe
// neuronal lié au wiki. L'idée : visualiser les pages wiki comme nœuds,
// les wiki-links `[[xxx]]` comme arêtes, et permettre d'explorer la
// mémoire par navigation plutôt que par arborescence de fichiers.
//
// Pour l'instant, la section est structurellement identique à
// MemorySidebarSection (titre + raccourci ⚙ + contenu désactivé) pour
// que l'utilisateur sache déjà où ça va vivre. Le contenu réel viendra
// dans un lot dédié (rendu d3/sigma + parsing des [[liens]]).

interface GraphSidebarSectionProps {
  collapsed: boolean
  onOpenGraph?: () => void
}

export default function GraphSidebarSection({
  collapsed,
  onOpenGraph
}: GraphSidebarSectionProps): React.ReactElement {
  if (collapsed) {
    return (
      <div className="flex justify-center px-2">
        <button
          type="button"
          disabled
          onClick={onOpenGraph}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] opacity-50"
          title="Graph — à venir"
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
        <button
          type="button"
          disabled
          onClick={onOpenGraph}
          className="rounded-[var(--radius-sm)] px-1 text-[10px] text-[var(--fg-muted)] opacity-50"
          title="Paramètres du Graph — à venir"
          aria-label="Paramètres du Graph"
        >
          ⚙
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] text-[var(--fg-muted)]">
          Graphe neuronal — à venir.
        </span>
        <button
          type="button"
          disabled
          className="rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] opacity-50"
          style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
          title="Visualisation réseau des pages wiki — pas encore implémenté"
        >
          ⬡ Ouvrir le graph
        </button>
      </div>
    </div>
  )
}
