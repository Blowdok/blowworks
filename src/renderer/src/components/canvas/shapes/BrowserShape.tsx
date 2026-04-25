import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  useEditor,
  type Editor,
  type TLBaseShape,
  type TLShapeId,
  type RecordProps
} from 'tldraw'
import { useProjectStore } from '../../../stores/project-store.js'
import { useUIStore } from '../../../stores/ui-store.js'
import {
  useShapeBorderState,
  getShapeBorderStyle
} from '../../../lib/use-shape-border-state.js'
import {
  DEFAULT_SEARCH_ENGINE_ID,
  getSearchEngine,
  type SearchEngine,
  type SearchEngineId
} from '@shared/search-engines.js'

// Shape "Browser" : navigateur web intégré via `<webview>` Electron, avec
// onglets multiples comme un navigateur classique.
//
// Modèle multi-onglets :
//   - `tabsJson` (JSON sérialisé `Tab[]`) : source de vérité des onglets.
//     Pas validé par un schéma tldraw imbriqué pour rester souple sur la
//     structure (ajout futur de favoris, pinned, etc.).
//   - `activeTabId` : id de l'onglet actuellement visible.
//   - `url` : LEGACY — URL de l'onglet actif, doublé en miroir pour rester
//     compatible avec les snapshots / IPC qui lisaient `shape.props.url`.
//
// Stratégie de rendu : tous les onglets sont MONTÉS en parallèle (un
// `<webview>` par onglet) ; seul l'actif est `display: block`, les autres
// `display: none`. Conséquence : RAM × N (un process Chromium par onglet)
// mais zéro lag de switch et aucun rechargement. C'est la stratégie Chrome.

const FALLBACK_HOMEPAGE = getSearchEngine(DEFAULT_SEARCH_ENGINE_ID).homepage

type StopInteractiveProps = {
  onPointerDown: (e: React.PointerEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
}

export interface Tab {
  id: string
  url: string
  title: string
  // `null` = pas de favicon connu (on affichera un globe par défaut).
  favicon: string | null
}

type BrowserShapeProps = {
  w: number
  h: number
  // LEGACY : URL de l'onglet actif. Tenu en miroir avec activeTab.url pour
  // rétrocompat avec les anciens snapshots / IPC. Source de vérité = tabsJson.
  url: string
  tabsJson: string
  activeTabId: string
  projectId: string | null
}

export type BrowserShape = TLBaseShape<'browser', BrowserShapeProps>

declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    browser: BrowserShapeProps
  }
}

// Migrations tldraw : les shapes existantes pré-onglets n'ont pas
// `tabsJson`/`activeTabId` → on les bootstrappe avec un seul onglet
// dérivé de l'ancien `url`.
const BrowserVersions = createShapePropsMigrationIds('browser', {
  AddTabs: 1
})

const browserShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: BrowserVersions.AddTabs,
      up: (props) => {
        const p = props as { url?: string; tabsJson?: unknown; activeTabId?: unknown }
        if (typeof p.tabsJson !== 'string') {
          const id = generateTabId()
          const url = typeof p.url === 'string' && p.url.length > 0 ? p.url : FALLBACK_HOMEPAGE
          ;(p as { tabsJson: string }).tabsJson = JSON.stringify([
            { id, url, title: '', favicon: null }
          ])
          ;(p as { activeTabId: string }).activeTabId = id
        }
      }
    }
  ]
})

export class BrowserShapeUtil extends BaseBoxShapeUtil<BrowserShape> {
  static override type = 'browser' as const
  static override props: RecordProps<BrowserShape> = {
    w: T.number,
    h: T.number,
    url: T.string,
    tabsJson: T.string,
    activeTabId: T.string,
    projectId: T.string.nullable()
  }
  static override migrations = browserShapeMigrations

  override getDefaultProps(): BrowserShape['props'] {
    const id = generateTabId()
    return {
      w: 900,
      h: 600,
      url: FALLBACK_HOMEPAGE,
      tabsJson: JSON.stringify([{ id, url: FALLBACK_HOMEPAGE, title: '', favicon: null }]),
      activeTabId: id,
      projectId: null
    }
  }

  override canEdit = (): boolean => true
  override canResize = (): boolean => true

  override onResize(
    shape: BrowserShape,
    info: { scaleX: number; scaleY: number }
  ): { props: { w: number; h: number } } {
    return {
      props: {
        w: Math.max(360, shape.props.w * info.scaleX),
        h: Math.max(240, shape.props.h * info.scaleY)
      }
    }
  }

  override component(shape: BrowserShape) {
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          background: 'transparent',
          pointerEvents: 'none'
        }}
      >
        <div
          data-blowworks-shape-id={shape.id}
          style={{ width: '100%', height: '100%' }}
        />
      </HTMLContainer>
    )
  }

  override indicator(shape: BrowserShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}

// ──────────────────────────────────────────────────────────── Helpers tabs

function generateTabId(): string {
  return `t_${Math.random().toString(36).slice(2, 10)}`
}

// Lecture défensive des onglets : si `tabsJson` est vide/illisible,
// fallback sur l'ancien `url` pour reconstituer un onglet unique.
function readTabs(shape: BrowserShape): { tabs: Tab[]; activeTabId: string } {
  const raw = shape.props.tabsJson
  if (raw && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as Tab[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        const activeTabId = parsed.some((t) => t.id === shape.props.activeTabId)
          ? shape.props.activeTabId
          : parsed[0].id
        return { tabs: parsed, activeTabId }
      }
    } catch {
      /* fall through */
    }
  }
  const id = 't0'
  return {
    tabs: [{ id, url: shape.props.url || FALLBACK_HOMEPAGE, title: '', favicon: null }],
    activeTabId: id
  }
}

function commitTabs(
  editor: Editor,
  shape: BrowserShape,
  tabs: Tab[],
  activeTabId: string
): void {
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  if (!active) return
  editor.updateShape<BrowserShape>({
    id: shape.id,
    type: 'browser',
    props: {
      tabsJson: JSON.stringify(tabs),
      activeTabId: active.id,
      url: active.url
    }
  })
}

// Met à jour partiellement un onglet (titre, favicon, url) sans toucher
// aux autres. Utilisé par les listeners did-navigate / page-title-updated /
// page-favicon-updated du webview.
function patchTab(
  editor: Editor,
  shapeId: TLShapeId,
  tabId: string,
  patch: Partial<Tab>
): void {
  const shape = editor.getShape(shapeId) as BrowserShape | undefined
  if (!shape) return
  const { tabs, activeTabId } = readTabs(shape)
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) return
  const current = tabs[idx]
  // Aucun changement effectif → on évite l'écriture pour ne pas spammer
  // le store tldraw (et la persistance SQLite derrière).
  const next: Tab = { ...current, ...patch }
  if (
    next.url === current.url &&
    next.title === current.title &&
    next.favicon === current.favicon
  ) {
    return
  }
  const nextTabs = tabs.slice()
  nextTabs[idx] = next
  commitTabs(editor, shape, nextTabs, activeTabId)
}

// ──────────────────────────────────────────────────────────── Registre webContents → tab
// Map (webContentsId → {shapeId, tabId}). Populée par chaque BrowserTabWebview
// au `did-attach` via `wv.getWebContentsId()`. Utilisée par InfiniteCanvas
// pour router les liens `target=_blank` (interceptés côté main) vers le bon
// onglet de la bonne shape, au lieu de spawner une nouvelle BrowserShape.

interface WebContentsBinding {
  shapeId: TLShapeId
  tabId: string
}

const webContentsRegistry = new Map<number, WebContentsBinding>()

export function lookupWebContentsBinding(id: number): WebContentsBinding | null {
  return webContentsRegistry.get(id) ?? null
}

// Ajoute un onglet à une shape EXISTANTE et active-le. Utilisé quand un
// lien target=_blank est intercepté côté main et que sa source est un
// webview connu via le registre.
export function addTabToShape(editor: Editor, shapeId: TLShapeId, url: string): void {
  const shape = editor.getShape(shapeId) as BrowserShape | undefined
  if (!shape) return
  const { tabs } = readTabs(shape)
  const id = generateTabId()
  const newTab: Tab = { id, url, title: '', favicon: null }
  commitTabs(editor, shape, [...tabs, newTab], id)
}

// ──────────────────────────────────────────────────────────── Resolveurs URL

export function resolveQuery(raw: string, engine: SearchEngine): string {
  const input = raw.trim()
  if (input.length === 0) return engine.homepage
  const hasSpace = /\s/.test(input)
  const hasDot = input.includes('.')
  if (hasSpace || !hasDot) {
    return engine.buildSearchUrl(input)
  }
  if (/^https?:\/\//i.test(input)) return input
  return `https://${input}`
}

export function resolveQueryWithCurrent(raw: string): string {
  const id: SearchEngineId = useUIStore.getState().searchEngine
  return resolveQuery(raw, getSearchEngine(id))
}

// ──────────────────────────────────────────────────────────── Portail content

export const BrowserPortalContent = memo(
  function BrowserPortalContentImpl({ shape }: { shape: BrowserShape }) {
    return <BrowserShapeView shape={shape} />
  },
  // Le memo doit se déclencher à chaque changement de tabs/active/projectId
  // (rerender du header + barre d'onglets) ET à chaque changement d'`url`
  // (compat ancienne navigation externe).
  (prev, next) =>
    prev.shape.id === next.shape.id &&
    prev.shape.props.url === next.shape.props.url &&
    prev.shape.props.tabsJson === next.shape.props.tabsJson &&
    prev.shape.props.activeTabId === next.shape.props.activeTabId &&
    prev.shape.props.projectId === next.shape.props.projectId
)

function BrowserShapeView({ shape }: { shape: BrowserShape }) {
  const editor = useEditor()
  const projects = useProjectStore((s) => s.projects)
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)

  const assignedProject = projects.find((p) => p.id === shape.props.projectId) ?? null

  const borderState = useShapeBorderState(shape.id)
  const borderStyle = getShapeBorderStyle(borderState, assignedProject?.color ?? null)

  // Recalcul memoïsé sur les 3 props qui décrivent l'état des onglets.
  // Pas `shape` complet en dep (tldraw le ré-instancie à chaque update,
  // ce qui annulerait le memo) — on liste explicitement les 3 inputs.
  const { tabs, activeTabId } = useMemo(
    () => readTabs(shape),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shape.props.tabsJson, shape.props.activeTabId, shape.props.url]
  )
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]

  const setActiveTab = (id: string): void => {
    if (id === activeTabId) return
    commitTabs(editor, shape, tabs, id)
  }

  const closeTab = (id: string): void => {
    const next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) {
      // Dernier onglet fermé → ferme la shape (convention Chrome).
      editor.deleteShape(shape.id)
      return
    }
    // Si on fermait l'onglet actif, basculer sur le voisin de droite,
    // sinon le voisin de gauche (comportement Chrome).
    let nextActiveId = activeTabId
    if (id === activeTabId) {
      const closedIdx = tabs.findIndex((t) => t.id === id)
      const candidate = tabs[closedIdx + 1] ?? tabs[closedIdx - 1]
      nextActiveId = candidate.id
    }
    commitTabs(editor, shape, next, nextActiveId)
  }

  const openNewTab = (): void => {
    const engine = getSearchEngine(useUIStore.getState().searchEngine)
    const id = generateTabId()
    const newTab: Tab = { id, url: engine.homepage, title: '', favicon: null }
    commitTabs(editor, shape, [...tabs, newTab], id)
  }

  function setProjectId(projectId: string | null): void {
    editor.updateShape<BrowserShape>({
      id: shape.id,
      type: 'browser',
      props: { projectId }
    })
    setProjectDropdownOpen(false)
  }

  const stopInteractive: StopInteractiveProps = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onTouchEnd: (e: React.TouchEvent) => e.stopPropagation()
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'hidden',
        background: 'var(--bg-primary, #000)',
        border: borderStyle.border,
        boxShadow: borderStyle.boxShadow,
        transition: borderStyle.transition,
        borderRadius: 'var(--radius-md, 8px)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <BrowserTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTab}
        onClose={closeTab}
        onNew={openNewTab}
        stopInteractive={stopInteractive}
      />
      <BrowserHeader
        shape={shape}
        activeTab={activeTab}
        assignedProject={assignedProject}
        stopInteractive={stopInteractive}
        projectDropdownOpen={projectDropdownOpen}
        setProjectDropdownOpen={setProjectDropdownOpen}
        setProjectId={setProjectId}
        projects={projects}
      />
      <BrowserTabsContainer
        shapeId={shape.id}
        tabs={tabs}
        activeTabId={activeTabId}
      />
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Barre d'onglets

function BrowserTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  stopInteractive
}: {
  tabs: Tab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  stopInteractive: StopInteractiveProps
}) {
  return (
    <div
      data-shape-tabbar
      className="flex h-7 items-end gap-0.5 border-b px-1 pt-1 text-[11px]"
      style={{
        background: 'var(--bg-primary, #000)',
        borderColor: 'var(--border, #2a2a2a)',
        // `pointer-events: none` sur le wrapper → les espaces vides entre
        // onglets restent en drag zone tldraw (cohérent avec le header en
        // dessous). Chaque onglet et le bouton + repassent en `auto`.
        pointerEvents: 'none'
      }}
    >
      <div
        className="no-scrollbar flex flex-1 items-end gap-0.5 overflow-x-auto"
        style={{ pointerEvents: 'auto' }}
        {...stopInteractive}
      >
        {tabs.map((tab) => (
          <BrowserTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
            stopInteractive={stopInteractive}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onNew}
        title="Nouvel onglet"
        aria-label="Nouvel onglet"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
        style={{ pointerEvents: 'auto' }}
        {...stopInteractive}
      >
        <PlusIcon />
      </button>
    </div>
  )
}

function BrowserTabItem({
  tab,
  active,
  onSelect,
  onClose,
  stopInteractive
}: {
  tab: Tab
  active: boolean
  onSelect: () => void
  onClose: () => void
  stopInteractive: StopInteractiveProps
}) {
  // Affichage : favicon (ou globe par défaut) + titre tronqué + croix au
  // hover. Largeur min 80, max 180 — comme Chrome, l'onglet rétrécit avec
  // le nombre d'onglets ouverts.
  const displayTitle = tab.title?.trim() || hostnameOf(tab.url) || 'Nouvel onglet'
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onAuxClick={(e) => {
        // Middle-click → ferme l'onglet (convention navigateur).
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      className="group relative flex h-6 min-w-[80px] max-w-[180px] cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2"
      style={{
        background: active ? 'var(--bg-secondary, #101010)' : 'transparent',
        borderColor: active ? 'var(--border, #2a2a2a)' : 'transparent',
        color: active ? 'var(--fg-primary, #e5e5e5)' : 'var(--fg-muted, #888)'
      }}
      {...stopInteractive}
    >
      <TabFavicon src={tab.favicon} />
      <span className="min-w-0 flex-1 truncate text-[11px]">{displayTitle}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        title="Fermer l'onglet"
        aria-label={`Fermer ${displayTitle}`}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--fg-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] group-hover:opacity-100"
        style={{ pointerEvents: 'auto' }}
        {...stopInteractive}
      >
        <CloseIcon />
      </button>
    </div>
  )
}

function TabFavicon({ src }: { src: string | null }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={12}
        height={12}
        // `referrerPolicy=no-referrer` : certains favicons (gstatic, etc.)
        // refusent un cross-origin avec referrer; on l'omet pour maximiser
        // les chances d'affichage. `onError` cache l'icône cassée.
        referrerPolicy="no-referrer"
        className="h-3 w-3 shrink-0"
        onError={(e) => {
          e.currentTarget.style.visibility = 'hidden'
        }}
      />
    )
  }
  return <GlobeIcon />
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ──────────────────────────────────────────────────────────── Header (URL bar)

function BrowserHeader({
  shape,
  activeTab,
  assignedProject,
  stopInteractive,
  projectDropdownOpen,
  setProjectDropdownOpen,
  setProjectId,
  projects
}: {
  shape: BrowserShape
  activeTab: Tab
  assignedProject: { id: string; name: string; color: string } | null
  stopInteractive: StopInteractiveProps
  projectDropdownOpen: boolean
  setProjectDropdownOpen: (fn: (v: boolean) => boolean) => void
  setProjectId: (id: string | null) => void
  projects: { id: string; name: string; color: string }[]
}) {
  const editor = useEditor()
  // Pattern "reset state during render" pour synchroniser draft <-> activeTab.url
  // sans useEffect. Re-clé sur l'id de l'onglet actif : un switch d'onglet
  // remet automatiquement l'URL bar à jour.
  const [draft, setDraft] = useState(activeTab.url)
  const [lastSeenKey, setLastSeenKey] = useState(`${activeTab.id}|${activeTab.url}`)
  const currentKey = `${activeTab.id}|${activeTab.url}`
  if (currentKey !== lastSeenKey) {
    setLastSeenKey(currentKey)
    setDraft(activeTab.url)
  }

  const searchEngineId = useUIStore((s) => s.searchEngine)
  const searchEngine = getSearchEngine(searchEngineId)

  const commit = (): void => {
    const resolved = resolveQuery(draft, searchEngine)
    if (resolved === activeTab.url) return
    patchTab(editor, shape.id, activeTab.id, { url: resolved })
  }

  const dispatch = (action: 'back' | 'forward' | 'reload'): void => {
    const slot = document.querySelector<HTMLElement>(
      `[data-shape-portal="${shape.id}"]`
    )
    slot?.dispatchEvent(
      new CustomEvent('blowworks-browser-action', {
        detail: { action, tabId: activeTab.id }
      })
    )
  }

  return (
    <div
      data-shape-header
      className="relative grid h-9 items-center gap-2 border-b px-2 text-[11px]"
      style={{
        background: 'var(--bg-secondary, #101010)',
        borderColor: 'var(--border, #2a2a2a)',
        color: 'var(--fg-primary, #e5e5e5)',
        gridTemplateColumns: 'auto 1fr auto',
        pointerEvents: 'none'
      }}
    >
      <div className="flex items-center gap-0.5" style={{ pointerEvents: 'auto' }}>
        <HeaderIconButton title="Retour" onClick={() => dispatch('back')} stopInteractive={stopInteractive}>
          <BackIcon />
        </HeaderIconButton>
        <HeaderIconButton title="Avancer" onClick={() => dispatch('forward')} stopInteractive={stopInteractive}>
          <ForwardIcon />
        </HeaderIconButton>
        <HeaderIconButton title="Recharger" onClick={() => dispatch('reload')} stopInteractive={stopInteractive}>
          <ReloadIcon />
        </HeaderIconButton>
      </div>

      <div className="flex min-w-0 justify-center">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          onBlur={commit}
          placeholder={`Rechercher sur ${searchEngine.label} ou saisir une URL…`}
          spellCheck={false}
          className="w-full max-w-[320px] min-w-0 rounded px-2 py-1 text-[11px] outline-none"
          style={{
            background: 'var(--bg-tertiary, #1a1a1a)',
            border: '1px solid var(--border, #2a2a2a)',
            color: 'var(--fg-primary, #e5e5e5)',
            pointerEvents: 'auto'
          }}
          {...stopInteractive}
        />
      </div>

      <button
        type="button"
        className="rounded px-1.5 py-0.5 font-mono text-[10px] hover:bg-[var(--bg-tertiary)]"
        style={{
          color: assignedProject ? assignedProject.color : 'var(--fg-primary, #e5e5e5)',
          pointerEvents: 'auto'
        }}
        onClick={() => setProjectDropdownOpen((v) => !v)}
        title="Assigner à un projet"
        {...stopInteractive}
      >
        {assignedProject ? `● ${assignedProject.name}` : '○ aucun projet'}
      </button>

      {projectDropdownOpen && (
        <div
          className="absolute right-2 top-9 z-10 min-w-[180px] overflow-hidden rounded border text-[11px] shadow-lg"
          style={{
            background: 'var(--bg-secondary, #101010)',
            borderColor: 'var(--border, #2a2a2a)',
            pointerEvents: 'auto'
          }}
          {...stopInteractive}
        >
          <button
            type="button"
            onClick={() => setProjectId(null)}
            className="block w-full px-2 py-1.5 text-left text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
            {...stopInteractive}
          >
            ○ Aucun projet
          </button>
          {projects.length === 0 && (
            <div className="px-2 py-1.5 text-[var(--fg-muted)]">
              (créez un projet dans la sidebar)
            </div>
          )}
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setProjectId(p.id)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)]"
              {...stopInteractive}
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              <span
                className="flex-1 truncate"
                style={{
                  color:
                    p.id === shape.props.projectId
                      ? p.color
                      : 'var(--fg-primary, #e5e5e5)',
                  fontWeight: p.id === shape.props.projectId ? 600 : 400
                }}
              >
                {p.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function HeaderIconButton({
  title,
  onClick,
  stopInteractive,
  children
}: {
  title: string
  onClick: () => void
  stopInteractive: StopInteractiveProps
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
      style={{ pointerEvents: 'auto' }}
      {...stopInteractive}
    >
      {children}
    </button>
  )
}

// ──────────────────────────────────────────────────────────── Container webviews

const SPOOFED_WEB_USER_AGENT = navigator.userAgent
  .replace(/\s*BlowWorks\/\S+/g, '')
  .replace(/\s*Electron\/\S+/g, '')
  .trim()

// Stratégie : tous les webviews montés en parallèle, seul l'actif est
// `display: block`. Les autres restent `display: none` pour préserver
// leur état (process Chromium toujours vivant). Switch zéro-lag, RAM × N.
function BrowserTabsContainer({
  shapeId,
  tabs,
  activeTabId
}: {
  shapeId: TLShapeId
  tabs: Tab[]
  activeTabId: string
}) {
  return (
    <div
      className="relative flex-1"
      style={{ minHeight: 0, pointerEvents: 'auto', background: '#fff' }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          style={{
            position: 'absolute',
            inset: 0,
            display: tab.id === activeTabId ? 'block' : 'none'
          }}
        >
          <BrowserTabWebview shapeId={shapeId} tabId={tab.id} initialUrl={tab.url} url={tab.url} />
        </div>
      ))}
    </div>
  )
}

// Un webview par onglet. `initialUrl` fige la première URL du tag (avant
// attach Chromium) ; les navigations ultérieures passent par `loadURL` ou
// par les liens cliqués dans la page (sans rerender).
function BrowserTabWebview({
  shapeId,
  tabId,
  initialUrl,
  url
}: {
  shapeId: TLShapeId
  tabId: string
  initialUrl: string
  url: string
}) {
  const editor = useEditor()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<HTMLElement | null>(null)
  const lastCommittedUrlRef = useRef<string>(initialUrl)
  const initialUrlRef = useRef<string>(initialUrl)

  // Création / destruction du webview au (dé)montage UNIQUEMENT.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const wv = document.createElement('webview') as HTMLElement
    // Ordre CRITIQUE : partition / allowpopups / useragent AVANT src.
    wv.setAttribute('partition', 'persist:browser')
    wv.setAttribute('allowpopups', 'true')
    wv.setAttribute('useragent', SPOOFED_WEB_USER_AGENT)
    wv.setAttribute('src', initialUrlRef.current)
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = '0'
    wv.style.background = '#fff'
    container.appendChild(wv)
    webviewRef.current = wv

    // Enregistrement webContentsId → {shapeId, tabId} dès l'attach pour
    // que les target=_blank émis par CE webview soient routés vers CET
    // onglet (au lieu de spawner une nouvelle BrowserShape).
    const onAttach = (): void => {
      const wcId = (wv as unknown as { getWebContentsId?: () => number })
        .getWebContentsId?.()
      if (typeof wcId === 'number') {
        webContentsRegistry.set(wcId, { shapeId, tabId })
      }
    }
    wv.addEventListener('did-attach', onAttach)

    return () => {
      wv.removeEventListener('did-attach', onAttach)
      // Nettoyage du registre — on supprime toute entrée pointant vers ce tab.
      for (const [k, v] of webContentsRegistry.entries()) {
        if (v.shapeId === shapeId && v.tabId === tabId) {
          webContentsRegistry.delete(k)
        }
      }
      wv.remove()
      webviewRef.current = null
    }
  }, [shapeId, tabId])

  // Navigation externe (URL bar, addTabToShape) → loadURL si le tag est prêt.
  useEffect(() => {
    const wv = webviewRef.current as
      | (HTMLElement & {
          loadURL?: (u: string) => Promise<void>
          getURL?: () => string
        })
      | null
    if (!wv) return
    if (url === lastCommittedUrlRef.current) return
    lastCommittedUrlRef.current = url
    if (typeof wv.loadURL === 'function') {
      wv.loadURL(url).catch((err) => {
        console.warn('[browser] loadURL échoué', err)
      })
    }
  }, [url])

  // did-navigate / did-navigate-in-page → met à jour l'URL du tab.
  const commitNavigatedUrl = useCallback(
    (u: string): void => {
      if (!u) return
      if (u === lastCommittedUrlRef.current) return
      lastCommittedUrlRef.current = u
      patchTab(editor, shapeId, tabId, { url: u })
    },
    [editor, shapeId, tabId]
  )

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onNavigate = (e: Event): void => {
      const ev = e as Event & { url?: string }
      if (typeof ev.url === 'string') commitNavigatedUrl(ev.url)
    }
    const onTitle = (e: Event): void => {
      const ev = e as Event & { title?: string }
      if (typeof ev.title === 'string') {
        patchTab(editor, shapeId, tabId, { title: ev.title })
      }
    }
    const onFavicon = (e: Event): void => {
      const ev = e as Event & { favicons?: string[] }
      const first = ev.favicons?.[0]
      if (typeof first === 'string') {
        patchTab(editor, shapeId, tabId, { favicon: first })
      }
    }
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('page-favicon-updated', onFavicon)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('page-favicon-updated', onFavicon)
    }
  }, [commitNavigatedUrl, editor, shapeId, tabId])

  // Masque la scrollbar interne pour cohérence UX (idem terminal/VSCode).
  useEffect(() => {
    const wv = webviewRef.current as
      | (HTMLElement & { insertCSS?: (css: string) => Promise<string> })
      | null
    if (!wv) return
    const hideScrollbarCSS =
      '::-webkit-scrollbar { width: 0 !important; height: 0 !important; background: transparent !important; } ' +
      'html { scrollbar-width: none !important; -ms-overflow-style: none !important; }'
    const inject = (): void => {
      wv.insertCSS?.(hideScrollbarCSS).catch(() => {
        /* webview peut être détruit — ignorer */
      })
    }
    wv.addEventListener('dom-ready', inject)
    wv.addEventListener('did-navigate', inject)
    return () => {
      wv.removeEventListener('dom-ready', inject)
      wv.removeEventListener('did-navigate', inject)
    }
  }, [])

  // Actions back/forward/reload : on filtre par tabId pour que le custom
  // event dispatché par le header n'agisse que sur le tab actif.
  useEffect(() => {
    const slot = document.querySelector<HTMLElement>(
      `[data-shape-portal="${shapeId}"]`
    )
    if (!slot) return
    const onAction = (e: Event): void => {
      const detail = (e as CustomEvent).detail as
        | { action: 'back' | 'forward' | 'reload'; tabId: string }
        | undefined
      if (!detail || detail.tabId !== tabId) return
      const wv = webviewRef.current as
        | (HTMLElement & {
            goBack?: () => void
            goForward?: () => void
            reload?: () => void
            canGoBack?: () => boolean
            canGoForward?: () => boolean
          })
        | null
      if (!wv) return
      if (detail.action === 'back' && wv.canGoBack?.()) wv.goBack?.()
      else if (detail.action === 'forward' && wv.canGoForward?.()) wv.goForward?.()
      else if (detail.action === 'reload') wv.reload?.()
    }
    slot.addEventListener('blowworks-browser-action', onAction)
    return () => slot.removeEventListener('blowworks-browser-action', onAction)
  }, [shapeId, tabId])

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ pointerEvents: 'auto', background: '#fff' }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    />
  )
}

// ──────────────────────────────────────────────────────────── Icônes

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ForwardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}
