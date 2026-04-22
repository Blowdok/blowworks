import { useEffect, useState } from 'react'
import { useUIStore } from '../stores/ui-store.js'
import { useProjectStore } from '../stores/project-store.js'
import { useEditorStore } from '../stores/editor-store.js'
import { useProjectBroadcast } from '../hooks/use-project-broadcast.js'
import {
  filterProjectShapes,
  arrangeProjectInGrid,
  slideToProject
} from '../lib/project-layout.js'
import ConfirmDialog from './ConfirmDialog.js'
import GitHubAccount from './GitHubAccount.js'
import SettingsModal from './SettingsModal.js'

// Barre latérale gauche : liste des projets + création + glissement caméra
// vers la zone déterministe de chaque projet. Chaque projet occupe sa
// propre zone sur l'axe X du canvas infini (cf. `project-layout.ts`), donc
// le clic enchaîne les projets dans un vrai corridor horizontal.

// Couleur par défaut du color picker à la création : cyan sobre cohérent
// avec la palette du projet (noir/gris/blanc/cyan, pas de violet/mauve).
// L'utilisateur reste libre de choisir n'importe quelle couleur.
const DEFAULT_PROJECT_COLOR = '#22d3ee'

export default function Sidebar() {
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const projects = useProjectStore((s) => s.projects)
  const createProject = useProjectStore((s) => s.create)
  const deleteProject = useProjectStore((s) => s.delete)
  const editor = useEditorStore((s) => s.editor)
  const broadcast = useProjectBroadcast()
  const [draft, setDraft] = useState('')
  const [draftColor, setDraftColor] = useState(DEFAULT_PROJECT_COLOR)
  // État de la modale de confirmation de suppression. Stocke le projet
  // ciblé (pour afficher son nom dans la modale) ou `null` si fermée.
  const [projectToDelete, setProjectToDelete] = useState<{
    id: string
    name: string
  } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Compteurs d'iframes par projet, recalculés à chaque mutation du store
  // tldraw (création/suppression/assignation d'une shape portail). Sans
  // cet abonnement, `countShapes` n'était évalué qu'au mount de la Sidebar
  // → les badges de la sidebar restaient figés jusqu'à un refresh manuel.
  // Pattern identique à celui du Header (`editor.store.listen`) — plus
  // fiable que `useValue` tldraw dans un composant rendu HORS du canvas.
  //
  // Une seule passe sur `allRecords()` suffit à remplir la Map entière
  // (au lieu de N passes si on appelle `filterProjectShapes` par projet
  // à chaque render) → O(shapes) au lieu de O(shapes × projets).
  const [projectCounts, setProjectCounts] = useState<Map<string, number>>(
    () => new Map()
  )

  useEffect(() => {
    if (!editor) return
    const recompute = (): void => {
      const validPageIds = new Set<string>(
        editor.getPages().map((p) => p.id as string)
      )
      const counts = new Map<string, number>()
      for (const record of editor.store.allRecords()) {
        if (record.typeName !== 'shape') continue
        const shape = record as {
          type: string
          parentId: string
          props: { projectId?: string | null }
        }
        if (!validPageIds.has(shape.parentId)) continue
        if (
          shape.type !== 'vscode' &&
          shape.type !== 'terminal' &&
          shape.type !== 'chat'
        ) {
          continue
        }
        const pid = shape.props.projectId
        if (pid == null) continue
        counts.set(pid, (counts.get(pid) ?? 0) + 1)
      }
      // Dedup via comparaison shallow : évite un re-render inutile si la
      // map sortie est identique à la précédente (utile car `editor.store
      // .listen` fire aussi pour les drag/resize qui ne changent pas le
      // nombre d'iframes par projet).
      setProjectCounts((prev) => {
        if (prev.size !== counts.size) return counts
        for (const [k, v] of counts) {
          if (prev.get(k) !== v) return counts
        }
        return prev
      })
    }
    recompute()
    const dispose = editor.store.listen(recompute)
    return dispose
  }, [editor])

  const width = collapsed ? 'w-16' : 'w-60'

  async function handleCreate(): Promise<void> {
    const name = draft.trim()
    if (!name) return
    await createProject({ name, color: draftColor })
    setDraft('')
    // La couleur, elle, reste — permet de créer plusieurs projets de la
    // même couleur rapidement si l'utilisateur le souhaite.
  }

  // Glissement caméra vers la zone déterministe du projet. Pas de zoom
  // sur la bbox actuelle des shapes (qui peuvent encore être éparpillées) :
  // le slide mène toujours à la zone qui sera occupée APRÈS rangement.
  // Cohérent avec l'effet "corridor horizontal de projets".
  function handleSlideToProject(projectId: string): void {
    if (!editor) return
    const matching = filterProjectShapes(editor, projectId)
    editor.setSelectedShapes(matching.map((s) => s.id))
    slideToProject(editor, projects, projectId)
  }

  // Range les shapes du projet dans sa zone déterministe (par rang) et
  // recadre la caméra. `editor.run` englobe tout → 1 seul step d'undo.
  function handleArrangeGrid(projectId: string): void {
    if (!editor) return
    arrangeProjectInGrid(editor, projects, projectId)
  }

  return (
    <aside
      className={`${width} flex h-full flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] transition-[width] duration-150`}
    >
      <div className="border-b border-[var(--border)] px-3 py-3">
        {!collapsed && (
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
            Projets
          </h2>
        )}
        <div className={`flex ${collapsed ? 'justify-center' : 'gap-2'}`}>
          {!collapsed && (
            <>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
                placeholder="Nouveau projet…"
                // `min-w-0` indispensable : sans ça, un input flex-1 ne
                // peut pas rétrécir sous la largeur de son placeholder
                // (défaut flexbox `min-width: auto`), ce qui pousse le
                // color picker et le bouton `+` hors du conteneur.
                className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-sm text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] focus:border-[var(--fg-secondary)] focus:outline-none"
              />
              <input
                type="color"
                value={draftColor}
                onChange={(e) => setDraftColor(e.target.value)}
                // Color picker natif HTML — prévisualisation immédiate +
                // palette OS. Style épuré pour fondre dans la barre.
                className="h-7 w-7 shrink-0 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--border)] bg-transparent p-0"
                aria-label="Couleur du nouveau projet"
                title="Couleur du projet (pastille, bordure iframe, liseré sidebar)"
              />
            </>
          )}
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-sm text-[var(--fg-secondary)] transition-colors hover:border-[var(--fg-secondary)]"
            aria-label="Créer un projet"
            title="Créer un projet"
          >
            +
          </button>
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto py-2">
        {projects.length === 0 && !collapsed && (
          <li className="px-3 py-2 text-xs text-[var(--fg-muted)]">Aucun projet.</li>
        )}
        {projects.map((p) => {
          const count = projectCounts.get(p.id) ?? 0
          return (
            <li
              key={p.id}
              className="group relative flex cursor-pointer items-center gap-2 py-1.5 pl-4 pr-3 text-sm hover:bg-[var(--bg-tertiary)]"
              onClick={() => handleSlideToProject(p.id)}
              title={collapsed ? p.name : 'Glisser la caméra vers la zone de ce projet'}
            >
              {/* Liseré vertical coloré (3 px) : identifie le projet d'un
                  coup d'œil même quand la pastille est cachée par le hover
                  ou une icône. Complémentaire à la bordure iframe colorée
                  déjà appliquée sur chaque shape affectée. */}
              <span
                aria-hidden
                className="absolute bottom-0 left-0 top-0 w-[3px]"
                style={{ backgroundColor: p.color }}
              />
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 rounded-full border border-[var(--border)]"
                style={{ backgroundColor: p.color }}
              />
              {!collapsed && (
                <>
                  <span className="flex-1 truncate text-[var(--fg-primary)]">{p.name}</span>
                  <span className="text-[10px] text-[var(--fg-muted)]">{count}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleArrangeGrid(p.id)
                    }}
                    className="invisible text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-secondary)] group-hover:visible"
                    aria-label={`Ranger les fenêtres de ${p.name} en grille`}
                    title="Ranger les fenêtres en grille (3 colonnes max, dans la zone du projet)"
                  >
                    ▦
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      const cmd = window.prompt(
                        `Commande à envoyer à tous les terminaux de « ${p.name} » :`
                      )
                      if (cmd && cmd.trim().length > 0) void broadcast(p.id, cmd)
                    }}
                    className="invisible text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-secondary)] group-hover:visible"
                    aria-label={`Envoyer une commande à tous les terminaux de ${p.name}`}
                    title="Diffuser une commande à tous les terminaux du projet"
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setProjectToDelete({ id: p.id, name: p.name })
                    }}
                    className="invisible text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-secondary)] group-hover:visible"
                    aria-label={`Supprimer le projet ${p.name}`}
                    title="Supprimer"
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>

      <footer className="flex flex-col gap-2 border-t border-[var(--border)] px-3 py-2">
        {/* Bouton Paramètres — placé AU-DESSUS du widget GitHub pour
            rester à portée de main quand la sidebar est collapsed, sans
            surcharger le Header. Adapte son layout au mode compact
            (icône seule centrée) vs étendu (icône + libellé à gauche). */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={`flex items-center rounded-[var(--radius-sm)] py-1.5 text-sm text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] ${
            collapsed ? 'justify-center px-2' : 'gap-2 px-2'
          }`}
          title="Paramètres"
          aria-label="Paramètres"
        >
          <GearIcon />
          {!collapsed && <span>Paramètres</span>}
        </button>
        <div className={collapsed ? 'flex justify-center' : ''}>
          <GitHubAccount compact={collapsed} />
        </div>
        {!collapsed && (
          <span className="text-[10px] text-[var(--fg-muted)]">BlowWorks v1.0.0</span>
        )}
      </footer>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ConfirmDialog
        open={projectToDelete !== null}
        title="Supprimer le projet"
        message={
          <>
            Le projet <strong>« {projectToDelete?.name} »</strong> sera
            supprimé. Les fenêtres (terminaux et VSCode) qui lui étaient
            affectées ne seront <em>pas</em> supprimées : elles redeviendront
            simplement « aucun projet ». Cette action est irréversible.
          </>
        }
        onCancel={() => setProjectToDelete(null)}
        onConfirm={() => {
          if (projectToDelete) void deleteProject(projectToDelete.id)
          setProjectToDelete(null)
        }}
      />
    </aside>
  )
}

// Icône « Paramètres » — style SVG 14×14 stroke-based cohérent avec
// les autres icônes custom de l'application (cf. `Header.tsx`).
function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01c.3.6.94 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
