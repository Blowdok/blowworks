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
import MemorySidebarSection from './MemorySidebarSection.js'
import GraphSidebarSection from './GraphSidebarSection.js'
import CanvasToolsSidebarSection from './CanvasToolsSidebarSection.js'
import WikiExplorerSidebar from './WikiExplorerSidebar.js'
import WikiPageViewer from './WikiPageViewer.js'
import WikiGraphModal from './WikiGraphModal.js'
import { useWikiStore } from '../stores/wiki-store.js'
import { useAppChromeStore, type SettingsTab } from '../stores/app-chrome-store.js'

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
  const settingsOpen = useAppChromeStore((s) => s.settingsOpen)
  const settingsInitialTab = useAppChromeStore((s) => s.settingsInitialTab)
  const openSettings = useAppChromeStore((s) => s.openSettings)
  const closeSettings = useAppChromeStore((s) => s.closeSettings)

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

  // Projet actif dans la sidebar (highlight visuel). Deux sources de mise
  // à jour : clic explicite sur un projet (via handleSlideToProject) OU
  // sélection d'une shape tldraw rattachée à un projet → on synchronise
  // automatiquement pour que l'utilisateur voie toujours "où il est".
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

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
          shape.type !== 'chat' &&
          shape.type !== 'browser'
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

      // Synchronise activeProjectId avec la 1re shape sélectionnée qui
      // porte un projectId. Si aucune shape n'est sélectionnée OU si la
      // sélection n'a aucun projet, on ne touche PAS à activeProjectId —
      // l'utilisateur garde la trace de son dernier clic sidebar.
      const selected = editor.getSelectedShapes()
      for (const s of selected) {
        const pid = (s.props as { projectId?: string | null }).projectId
        if (pid) {
          setActiveProjectId((prev) => (prev === pid ? prev : pid))
          break
        }
      }
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
    setActiveProjectId(projectId)
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

  // Mode d'affichage de la sidebar : standard (projets/mémoire/graph)
  // ou explorateur wiki plein cadre. Déclenché par le bouton 📖 dans
  // la section Mémoire. Footer Paramètres+GitHub reste visible dans
  // les deux modes.
  const sidebarMode = useWikiStore((s) => s.sidebarMode)

  return (
    <aside
      className={`${width} flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-secondary)] transition-[width] duration-150`}
    >
      {sidebarMode === 'wiki-explorer' ? (
        <WikiExplorerSidebar collapsed={collapsed} />
      ) : (
        <StandardSidebarContent
          collapsed={collapsed}
          draft={draft}
          setDraft={setDraft}
          draftColor={draftColor}
          setDraftColor={setDraftColor}
          handleCreate={handleCreate}
          projects={projects}
          projectCounts={projectCounts}
          activeProjectId={activeProjectId}
          handleSlideToProject={handleSlideToProject}
          handleArrangeGrid={handleArrangeGrid}
          broadcast={broadcast}
          setProjectToDelete={setProjectToDelete}
          openSettings={openSettings}
        />
      )}

      <Footer
        collapsed={collapsed}
        onOpenSettings={() => openSettings()}
      />

      <WikiPageViewer />

      <WikiGraphModalMount />

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        initialTab={settingsInitialTab}
      />

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
        confirmLabel="Supprimer"
        onConfirm={() => {
          if (projectToDelete) void deleteProject(projectToDelete.id)
          setProjectToDelete(null)
        }}
        onCancel={() => setProjectToDelete(null)}
      />
    </aside>
  )
}

// ─────────────────────────────────────────────────────── StandardSidebarContent

// Contenu de la sidebar en mode standard. Extrait de Sidebar pour alléger
// le JSX principal et permettre le switch avec WikiExplorerSidebar.
interface StandardSidebarContentProps {
  collapsed: boolean
  draft: string
  setDraft: (v: string) => void
  draftColor: string
  setDraftColor: (v: string) => void
  handleCreate: () => Promise<void>
  projects: ReturnType<typeof useProjectStore.getState>['projects']
  projectCounts: Map<string, number>
  activeProjectId: string | null
  handleSlideToProject: (id: string) => void
  handleArrangeGrid: (id: string) => void
  broadcast: (projectId: string, cmd: string) => Promise<void>
  setProjectToDelete: (p: { id: string; name: string } | null) => void
  openSettings: (tab?: SettingsTab) => void
}

function StandardSidebarContent(props: StandardSidebarContentProps): React.ReactElement {
  const {
    collapsed,
    draft,
    setDraft,
    draftColor,
    setDraftColor,
    handleCreate,
    projects,
    projectCounts,
    activeProjectId,
    handleSlideToProject,
    handleArrangeGrid,
    broadcast,
    setProjectToDelete,
    openSettings
  } = props

  return (
    <>
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
          const isActive = p.id === activeProjectId
          return (
            <li
              key={p.id}
              className="group relative flex cursor-pointer items-center gap-2 py-1.5 pl-4 pr-3 text-sm hover:bg-[var(--bg-tertiary)]"
              onClick={() => handleSlideToProject(p.id)}
              title={collapsed ? p.name : 'Glisser la caméra vers la zone de ce projet'}
              style={{
                // Projet actif : fond teinté (bg-tertiary) + pseudo-état
                // persistant même sans hover. Le liseré passe aussi en
                // 4 px (vs 3 px au repos) pour renforcer la lecture.
                background: isActive ? 'var(--bg-tertiary)' : undefined
              }}
              aria-current={isActive ? 'true' : undefined}
            >
              {/* Liseré vertical coloré : 3 px au repos, 4 px si actif.
                  Identifie le projet même quand la pastille est cachée
                  par un hover ou une icône. */}
              <span
                aria-hidden
                className="absolute bottom-0 left-0 top-0"
                style={{ backgroundColor: p.color, width: isActive ? 4 : 3 }}
              />
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 rounded-full border border-[var(--border)]"
                style={{ backgroundColor: p.color }}
              />
              {!collapsed && (
                <>
                  <span
                    className="flex-1 truncate text-[var(--fg-primary)]"
                    style={{ fontWeight: isActive ? 600 : 400 }}
                  >
                    {p.name}
                  </span>
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

      {/* Section Mémoire — séparée de la liste des projets par une
          border-t nette (cohérent avec le header Projets qui a border-b).
          Reste en dessous de la liste scrollable, avant le footer. */}
      <section className="shrink-0 border-t border-[var(--border)] py-2">
        <MemorySidebarSection
          collapsed={collapsed}
          onOpenWikiSettings={() => openSettings('wiki')}
        />
      </section>

      {/* Section Graph — placeholder pour le futur graphe neuronal
          construit à partir des wiki-links du wiki. Désactivée pour
          l'instant. Séparée par border-t comme les autres sections. */}
      <section className="shrink-0 border-t border-[var(--border)] py-2">
        <GraphSidebarSection collapsed={collapsed} />
      </section>

      {/* Section Tools Canvas — toggles des éléments natifs tldraw
          (panneau de styles + barre d'outils du bas). Déplacés depuis
          le Header pour libérer de la place dans la barre du haut. */}
      <section className="shrink-0 border-t border-[var(--border)] py-2">
        <CanvasToolsSidebarSection collapsed={collapsed} />
      </section>
    </>
  )
}

// Wrapper qui branche le wiki-store à WikiGraphModal pour que n'importe
// quel composant (GraphSidebarSection en l'occurrence) puisse ouvrir le
// graph via `setGraphOpen(true)` sans connaître le composant modal.
function WikiGraphModalMount(): React.ReactElement {
  const open = useWikiStore((s) => s.graphOpen)
  const setGraphOpen = useWikiStore((s) => s.setGraphOpen)
  return <WikiGraphModal open={open} onClose={() => setGraphOpen(false)} />
}

// ─────────────────────────────────────────────────────── Footer (commun)

// Footer commun aux 2 modes de sidebar (standard / wiki-explorer).
// Reste toujours visible en bas — ne se fait JAMAIS pousser hors écran
// grâce au `shrink-0`.
function Footer({
  collapsed,
  onOpenSettings
}: {
  collapsed: boolean
  onOpenSettings: () => void
}): React.ReactElement {
  return (
    <footer className="flex shrink-0 flex-col gap-2 border-t border-[var(--border)] px-3 py-2">
      <button
        type="button"
        onClick={onOpenSettings}
        className={`flex w-full items-center rounded-[var(--radius-sm)] py-1.5 text-sm text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] ${
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
        <span className="text-[10px] text-[var(--fg-muted)]">BlowWorks v{__APP_VERSION__}</span>
      )}
    </footer>
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
