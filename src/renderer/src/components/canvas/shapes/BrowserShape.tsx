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
import { useBrowserStore } from '../../../stores/browser-store.js'
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
        // `pointer-events: none` PARTOUT par défaut sur la barre — les
        // zones vides (entre onglets, après le dernier onglet) restent en
        // drag zone tldraw, pour que cliquer ailleurs qu'un onglet
        // sélectionne la shape (bordure bleue + handles de resize).
        // Seuls les onglets et le bouton + repassent en `auto`.
        pointerEvents: 'none'
      }}
    >
      <div
        // Pas de `pointerEvents: 'auto'` ici : ce wrapper sert juste au
        // layout flex/scroll. Si on le mettait à 'auto', le `flex-1`
        // l'étendrait à toute la largeur disponible et capturerait les
        // clics sur les espaces vides, bloquant la sélection tldraw.
        // Conséquence : le scroll horizontal à la souris est désactivé sur
        // les zones VIDES de la barre, mais reste possible en hover sur un
        // onglet (qui lui a `pointerEvents: 'auto'`).
        className="no-scrollbar flex flex-1 items-end gap-0.5 overflow-x-auto"
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
        color: active ? 'var(--fg-primary, #e5e5e5)' : 'var(--fg-muted, #888)',
        // L'onglet doit recevoir les pointer events (le wrapper barre est
        // en `pointer-events: none` pour laisser passer la sélection tldraw
        // dans les zones vides). Sans `auto` ici, le clic glisserait à
        // travers et la shape se sélectionnerait au lieu d'activer le tab.
        pointerEvents: 'auto'
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

  // Dispatch d'action vers le webview de l'onglet actif. Pour `navigate`,
  // l'URL cible est passée dans le payload (utilisé par le bouton Accueil
  // et les clics sur favoris/historique → ouverture dans l'onglet courant).
  const dispatch = (
    action: 'back' | 'forward' | 'reload' | 'navigate',
    extra?: { url?: string }
  ): void => {
    const slot = document.querySelector<HTMLElement>(
      `[data-shape-portal="${shape.id}"]`
    )
    slot?.dispatchEvent(
      new CustomEvent('blowworks-browser-action', {
        detail: { action, tabId: activeTab.id, ...extra }
      })
    )
  }

  const goHome = (): void => {
    const url = searchEngine.homepage
    // Mise à jour de l'URL côté state (URL bar) ET commande loadURL
    // côté webview. `patchTab` à elle seule déclenche aussi loadURL via
    // l'effet de re-render du BrowserTabWebview.
    patchTab(editor, shape.id, activeTab.id, { url })
  }

  // ── Étoile (favori sur l'URL courante) ─────────────────────────
  const bookmarkedUrls = useBrowserStore((s) => s.bookmarkedUrls)
  const toggleBookmarkAction = useBrowserStore((s) => s.toggleBookmark)
  const isBookmarked = bookmarkedUrls.has(activeTab.url)

  const onToggleBookmark = (): void => {
    void toggleBookmarkAction({
      url: activeTab.url,
      title: activeTab.title || hostnameOf(activeTab.url),
      favicon: activeTab.favicon
    })
  }

  // ── Dropdowns Historique / Favoris / Téléchargements ──────────
  const [historyOpen, setHistoryOpen] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const activeDownloadsCount = useBrowserStore((s) => s.activeDownloadsCount)

  const openInActiveTab = (url: string): void => {
    patchTab(editor, shape.id, activeTab.id, { url })
    setHistoryOpen(false)
    setBookmarksOpen(false)
    setDownloadsOpen(false)
  }

  const closeAllDropdowns = (): void => {
    setHistoryOpen(false)
    setBookmarksOpen(false)
    setDownloadsOpen(false)
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
        <HeaderIconButton title={`Accueil (${searchEngine.label})`} onClick={goHome} stopInteractive={stopInteractive}>
          <HomeIcon />
        </HeaderIconButton>
      </div>

      <div className="flex min-w-0 items-center justify-center gap-1">
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
        <HeaderIconButton
          title={isBookmarked ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          onClick={onToggleBookmark}
          stopInteractive={stopInteractive}
        >
          <StarIcon filled={isBookmarked} />
        </HeaderIconButton>
        <HeaderIconButton
          title="Favoris"
          onClick={() => {
            const next = !bookmarksOpen
            closeAllDropdowns()
            setBookmarksOpen(next)
          }}
          stopInteractive={stopInteractive}
        >
          <BookmarksIcon />
        </HeaderIconButton>
        <HeaderIconButton
          title="Historique"
          onClick={() => {
            const next = !historyOpen
            closeAllDropdowns()
            setHistoryOpen(next)
          }}
          stopInteractive={stopInteractive}
        >
          <HistoryIcon />
        </HeaderIconButton>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <HeaderIconButton
            title="Téléchargements"
            onClick={() => {
              const next = !downloadsOpen
              closeAllDropdowns()
              setDownloadsOpen(next)
            }}
            stopInteractive={stopInteractive}
          >
            <DownloadIcon />
          </HeaderIconButton>
          {activeDownloadsCount > 0 && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                minWidth: 14,
                height: 14,
                padding: '0 3px',
                borderRadius: 7,
                background: '#22c55e',
                color: '#000',
                fontSize: 9,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none'
              }}
            >
              {activeDownloadsCount}
            </span>
          )}
        </div>
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

      {historyOpen && (
        <HistoryPanel
          onOpen={openInActiveTab}
          onClose={() => setHistoryOpen(false)}
          stopInteractive={stopInteractive}
        />
      )}

      {bookmarksOpen && (
        <BookmarksPanel
          onOpen={openInActiveTab}
          onClose={() => setBookmarksOpen(false)}
          stopInteractive={stopInteractive}
        />
      )}

      {downloadsOpen && (
        <DownloadsPanel
          onClose={() => setDownloadsOpen(false)}
          stopInteractive={stopInteractive}
        />
      )}

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
  // Id de l'entrée d'historique de la NAVIGATION en cours pour cet onglet.
  // Mis à jour à chaque did-navigate (nouvelle entrée), puis patché par
  // les events page-title-updated / page-favicon-updated qui arrivent
  // de manière asynchrone après did-navigate.
  const currentHistoryIdRef = useRef<number | null>(null)
  const recordVisit = useBrowserStore((s) => s.recordVisit)
  const patchVisit = useBrowserStore((s) => s.patchVisit)

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

  // did-navigate / did-navigate-in-page → met à jour l'URL du tab +
  // enregistre une nouvelle entrée d'historique. L'id retourné par
  // recordVisit est conservé en ref pour permettre aux events
  // page-title-updated / page-favicon-updated (qui arrivent ensuite)
  // de patcher la MÊME entrée d'historique.
  const commitNavigatedUrl = useCallback(
    (u: string): void => {
      if (!u) return
      if (u === lastCommittedUrlRef.current) return
      lastCommittedUrlRef.current = u
      patchTab(editor, shapeId, tabId, { url: u })
      // about:blank, chrome-error://, et les schémas non-web n'ont pas
      // d'intérêt dans l'historique utilisateur — on filtre ici.
      if (/^https?:\/\//i.test(u)) {
        void recordVisit({ url: u }).then((id) => {
          currentHistoryIdRef.current = id
        })
      } else {
        currentHistoryIdRef.current = null
      }
    },
    [editor, shapeId, tabId, recordVisit]
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
        const histId = currentHistoryIdRef.current
        if (histId !== null) {
          void patchVisit(histId, { title: ev.title })
        }
      }
    }
    const onFavicon = (e: Event): void => {
      const ev = e as Event & { favicons?: string[] }
      const first = ev.favicons?.[0]
      if (typeof first === 'string') {
        patchTab(editor, shapeId, tabId, { favicon: first })
        const histId = currentHistoryIdRef.current
        if (histId !== null) {
          void patchVisit(histId, { favicon: first })
        }
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
  }, [commitNavigatedUrl, editor, shapeId, tabId, patchVisit])

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
        | {
            action: 'back' | 'forward' | 'reload' | 'navigate'
            tabId: string
            url?: string
          }
        | undefined
      if (!detail || detail.tabId !== tabId) return
      const wv = webviewRef.current as
        | (HTMLElement & {
            goBack?: () => void
            goForward?: () => void
            reload?: () => void
            canGoBack?: () => boolean
            canGoForward?: () => boolean
            loadURL?: (u: string) => Promise<void>
          })
        | null
      if (!wv) return
      if (detail.action === 'back' && wv.canGoBack?.()) wv.goBack?.()
      else if (detail.action === 'forward' && wv.canGoForward?.()) wv.goForward?.()
      else if (detail.action === 'reload') wv.reload?.()
      else if (detail.action === 'navigate' && typeof detail.url === 'string') {
        wv.loadURL?.(detail.url).catch((err) => {
          console.warn('[browser] loadURL (navigate) échoué', err)
        })
      }
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

function HomeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12 12 3l9 9" />
      <path d="M5 10v10h14V10" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: filled ? '#facc15' : 'currentColor' }}
    >
      <polygon points="12 2 15 9 22 9.5 16.5 14.5 18 22 12 18 6 22 7.5 14.5 2 9.5 9 9" />
    </svg>
  )
}

function BookmarksIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

// ──────────────────────────────────────────────────────────── Panneau Historique

// Dropdown ancré sous le bouton Historique de la barre URL. Charge la
// liste à l'ouverture, recherche LIKE côté SQLite. Ouvre un clic dans
// l'onglet courant (pas de nouvel onglet — convention Chrome : Ctrl+clic
// pour nouvel onglet, qu'on n'implémente pas ici par simplicité).
function HistoryPanel({
  onOpen,
  onClose,
  stopInteractive
}: {
  onOpen: (url: string) => void
  onClose: () => void
  stopInteractive: StopInteractiveProps
}) {
  const [entries, setEntries] = useState<
    Array<{
      id: number
      url: string
      title: string
      favicon: string | null
      visitedAt: number
    }>
  >([])
  const [search, setSearch] = useState('')
  const listHistory = useBrowserStore((s) => s.listHistory)
  const deleteEntry = useBrowserStore((s) => s.deleteHistoryEntry)
  const clear = useBrowserStore((s) => s.clearHistory)

  // Charge la liste à chaque changement de recherche. Pattern annulable :
  // un fetch lent ne peut pas écraser un fetch plus récent (StrictMode-safe).
  useEffect(() => {
    let cancelled = false
    listHistory({ limit: 200, search }).then((list) => {
      if (!cancelled) setEntries(list)
    })
    return () => {
      cancelled = true
    }
  }, [listHistory, search])

  // Helper pour rafraîchir manuellement après une mutation (delete/clear).
  const refreshNow = useCallback(async () => {
    const list = await listHistory({ limit: 200, search })
    setEntries(list)
  }, [listHistory, search])

  return (
    <div
      className="absolute right-2 top-9 z-20 max-h-[420px] w-[360px] overflow-hidden rounded border text-[11px] shadow-lg"
      style={{
        background: 'var(--bg-secondary, #101010)',
        borderColor: 'var(--border, #2a2a2a)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column'
      }}
      {...stopInteractive}
    >
      <div
        className="flex items-center gap-2 border-b px-2 py-1.5"
        style={{ borderColor: 'var(--border, #2a2a2a)' }}
      >
        <span className="text-[var(--fg-muted)]">Historique</span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher…"
          className="flex-1 rounded px-2 py-1 outline-none"
          style={{
            background: 'var(--bg-tertiary, #1a1a1a)',
            border: '1px solid var(--border, #2a2a2a)',
            color: 'var(--fg-primary, #e5e5e5)'
          }}
          {...stopInteractive}
        />
        <button
          type="button"
          onClick={async () => {
            await clear()
            setSearch('')
            void refreshNow()
          }}
          className="rounded px-1.5 py-1 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title="Tout effacer"
          {...stopInteractive}
        >
          Effacer
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title="Fermer"
          {...stopInteractive}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 && (
          <div className="px-3 py-4 text-center text-[var(--fg-muted)]">
            {search ? 'Aucun résultat' : 'Aucune visite'}
          </div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="group flex items-center gap-2 border-b px-2 py-1.5 hover:bg-[var(--bg-tertiary)]"
            style={{ borderColor: 'var(--border, #2a2a2a)' }}
          >
            <button
              type="button"
              onClick={() => onOpen(entry.url)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              {...stopInteractive}
            >
              <TabFavicon src={entry.favicon} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[var(--fg-primary)]">
                  {entry.title || hostnameOf(entry.url) || entry.url}
                </div>
                <div className="truncate text-[10px] text-[var(--fg-muted)]">
                  {hostnameOf(entry.url)} · {formatRelativeTime(entry.visitedAt)}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={async () => {
                await deleteEntry(entry.id)
                void refreshNow()
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--fg-muted)] opacity-0 hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] group-hover:opacity-100"
              title="Supprimer"
              {...stopInteractive}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Panneau Favoris

function BookmarksPanel({
  onOpen,
  onClose,
  stopInteractive
}: {
  onOpen: (url: string) => void
  onClose: () => void
  stopInteractive: StopInteractiveProps
}) {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const removeBookmark = useBrowserStore((s) => s.removeBookmark)

  return (
    <div
      className="absolute right-2 top-9 z-20 max-h-[420px] w-[320px] overflow-hidden rounded border text-[11px] shadow-lg"
      style={{
        background: 'var(--bg-secondary, #101010)',
        borderColor: 'var(--border, #2a2a2a)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column'
      }}
      {...stopInteractive}
    >
      <div
        className="flex items-center gap-2 border-b px-2 py-1.5"
        style={{ borderColor: 'var(--border, #2a2a2a)' }}
      >
        <span className="flex-1 text-[var(--fg-muted)]">Favoris</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title="Fermer"
          {...stopInteractive}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {bookmarks.length === 0 && (
          <div className="px-3 py-4 text-center text-[var(--fg-muted)]">
            Aucun favori. Clique sur ⭐ pour en ajouter.
          </div>
        )}
        {bookmarks.map((bm) => (
          <div
            key={bm.id}
            className="group flex items-center gap-2 border-b px-2 py-1.5 hover:bg-[var(--bg-tertiary)]"
            style={{ borderColor: 'var(--border, #2a2a2a)' }}
          >
            <button
              type="button"
              onClick={() => onOpen(bm.url)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              {...stopInteractive}
            >
              <TabFavicon src={bm.favicon} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[var(--fg-primary)]">
                  {bm.title || hostnameOf(bm.url) || bm.url}
                </div>
                <div className="truncate text-[10px] text-[var(--fg-muted)]">
                  {hostnameOf(bm.url)}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => void removeBookmark(bm.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--fg-muted)] opacity-0 hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] group-hover:opacity-100"
              title="Retirer"
              {...stopInteractive}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Panneau Téléchargements

function DownloadsPanel({
  onClose,
  stopInteractive
}: {
  onClose: () => void
  stopInteractive: StopInteractiveProps
}) {
  const downloads = useBrowserStore((s) => s.downloads)
  const cancelDl = useBrowserStore((s) => s.cancelDownload)
  const openDl = useBrowserStore((s) => s.openDownload)
  const showDl = useBrowserStore((s) => s.showDownloadInFolder)
  const clearDl = useBrowserStore((s) => s.clearDownloads)
  const refresh = useBrowserStore((s) => s.refreshDownloads)

  // Refresh à l'ouverture pour s'aligner sur la DB (le store accumule via
  // onProgress mais peut manquer un download spawné dans une autre fenêtre).
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div
      className="absolute right-2 top-9 z-20 max-h-[420px] w-[380px] overflow-hidden rounded border text-[11px] shadow-lg"
      style={{
        background: 'var(--bg-secondary, #101010)',
        borderColor: 'var(--border, #2a2a2a)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column'
      }}
      {...stopInteractive}
    >
      <div
        className="flex items-center gap-2 border-b px-2 py-1.5"
        style={{ borderColor: 'var(--border, #2a2a2a)' }}
      >
        <span className="flex-1 text-[var(--fg-muted)]">Téléchargements</span>
        <button
          type="button"
          onClick={() => void clearDl()}
          className="rounded px-1.5 py-1 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title="Effacer les terminés"
          {...stopInteractive}
        >
          Effacer
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title="Fermer"
          {...stopInteractive}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {downloads.length === 0 && (
          <div className="px-3 py-4 text-center text-[var(--fg-muted)]">
            Aucun téléchargement
          </div>
        )}
        {downloads.map((dl) => (
          <DownloadRow
            key={dl.id}
            dl={dl}
            onCancel={() => void cancelDl(dl.id)}
            onOpen={() => void openDl(dl.id)}
            onShow={() => void showDl(dl.id)}
            stopInteractive={stopInteractive}
          />
        ))}
      </div>
    </div>
  )
}

function DownloadRow({
  dl,
  onCancel,
  onOpen,
  onShow,
  stopInteractive
}: {
  dl: import('../../../stores/browser-store.js').DownloadEntry
  onCancel: () => void
  onOpen: () => void
  onShow: () => void
  stopInteractive: StopInteractiveProps
}) {
  const pct = dl.totalBytes > 0 ? Math.min(100, (dl.receivedBytes / dl.totalBytes) * 100) : 0
  const stateLabel =
    dl.state === 'progressing'
      ? `${formatBytes(dl.receivedBytes)} / ${dl.totalBytes > 0 ? formatBytes(dl.totalBytes) : '?'}`
      : dl.state === 'completed'
        ? formatBytes(dl.totalBytes)
        : dl.state === 'cancelled'
          ? 'Annulé'
          : 'Interrompu'

  return (
    <div
      className="border-b px-2 py-1.5"
      style={{ borderColor: 'var(--border, #2a2a2a)' }}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[var(--fg-primary)]">{dl.filename}</div>
          <div className="truncate text-[10px] text-[var(--fg-muted)]">
            {hostnameOf(dl.url)} · {stateLabel}
          </div>
        </div>
        {dl.state === 'progressing' && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
            title="Annuler"
            {...stopInteractive}
          >
            Annuler
          </button>
        )}
        {dl.state === 'completed' && (
          <>
            <button
              type="button"
              onClick={onOpen}
              className="rounded px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              title="Ouvrir le fichier"
              {...stopInteractive}
            >
              Ouvrir
            </button>
            <button
              type="button"
              onClick={onShow}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              title="Afficher dans le dossier"
              {...stopInteractive}
            >
              <FolderIcon />
            </button>
          </>
        )}
      </div>
      {dl.state === 'progressing' && (
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded"
          style={{ background: 'var(--bg-tertiary, #1a1a1a)' }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: '#22c55e',
              transition: 'width 0.15s ease-out'
            }}
          />
        </div>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`
}

// Format de date relatif court adapté à un dropdown : "à l'instant",
// "il y a 5 min", "il y a 2 h", "hier", "il y a N j", puis date complète.
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "à l'instant"
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `il y a ${min} min`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `il y a ${hr} h`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'hier'
  if (day < 7) return `il y a ${day} j`
  try {
    return new Date(ts).toLocaleDateString('fr-FR')
  } catch {
    return ''
  }
}
