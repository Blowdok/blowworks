import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  type TLBaseShape,
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

// Shape "Browser" : navigateur web intégré via le tag <webview> Electron.
// Contrairement à une iframe, <webview> n'est pas soumis aux blocages
// X-Frame-Options / CSP frame-ancestors de la page cible — on peut
// donc charger n'importe quel site (Google, GitHub, YouTube…).
// Activé côté main via `webPreferences.webviewTag = true`.
// Le tag `<webview>` est typé par @types/react (HTMLWebViewElement) ;
// `allowpopups` est une string en HTML Electron bien que typée boolean
// côté DOM — on passe par un cast léger à l'usage.

// Homepage de secours utilisée par `getDefaultProps()` (cas où une browser
// shape est créée par la barre d'outils tldraw plutôt que via
// `spawnBrowserShape`). Pour les vrais spawns (boutons, lien intercepté),
// `spawnBrowserShape` lit le moteur courant dans `useUIStore` et utilise
// `engine.homepage`. Ici on n'a pas accès au store (méthode statique de
// la classe shape util), d'où le fallback figé sur le défaut DEFAULT_SEARCH_ENGINE_ID.
const FALLBACK_HOMEPAGE = getSearchEngine(DEFAULT_SEARCH_ENGINE_ID).homepage

type StopInteractiveProps = {
  onPointerDown: (e: React.PointerEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
}

type BrowserShapeProps = {
  w: number
  h: number
  // URL persistée : restaurée au reload de l'app (chaque shape reprend
  // là où elle était). Initialisée à DDG au spawn.
  url: string
  projectId: string | null
}

export type BrowserShape = TLBaseShape<'browser', BrowserShapeProps>

declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    browser: BrowserShapeProps
  }
}

export class BrowserShapeUtil extends BaseBoxShapeUtil<BrowserShape> {
  static override type = 'browser' as const
  static override props: RecordProps<BrowserShape> = {
    w: T.number,
    h: T.number,
    url: T.string,
    projectId: T.string.nullable()
  }

  override getDefaultProps(): BrowserShape['props'] {
    return {
      w: 900,
      h: 600,
      url: FALLBACK_HOMEPAGE,
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

  // Placeholder transparent : le vrai contenu (webview + barre d'URL)
  // est rendu hors tldraw par `ShapePortalManager` pour que le webview
  // survive aux switch de pages tldraw (sinon remount → rechargement
  // complet de la page web).
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

// Convertit une saisie utilisateur en URL navigable.
// Règles :
//   - texte avec espaces OU sans point               → recherche moteur courant
//   - commence par http:// ou https://               → URL directe
//   - sinon (ex: "github.com/foo")                   → préfixe https://
//
// Le moteur est passé en argument pour rester pur (pas d'accès store),
// les appelants (BrowserHeader, spawnBrowserShape) lisent `useUIStore.searchEngine`
// et résolvent le SearchEngine via `getSearchEngine`.
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

// Helper renderer-only : évite à chaque appelant de répéter le getState +
// getSearchEngine. Lit l'état CURRENT du store (snapshot, sans subscription).
export function resolveQueryWithCurrent(raw: string): string {
  const id: SearchEngineId = useUIStore.getState().searchEngine
  return resolveQuery(raw, getSearchEngine(id))
}

// Contenu réel de la shape Browser — rendu hors tldraw par ShapePortalManager.
// Mémorisé strictement sur l'identité de la shape pour qu'un resize ou un
// changement de projectId ne remount pas le <webview> (sinon rechargement
// complet de la page en cours).
export const BrowserPortalContent = memo(
  function BrowserPortalContentImpl({ shape }: { shape: BrowserShape }) {
    return <BrowserShapeView shape={shape} />
  },
  // `projectId` DOIT figurer dans le comparator : sans lui, le memo bloque
  // le re-render lors d'un changement d'assignation projet → la bordure
  // colorée (dérivée de `assignedProject.color`) ne s'applique pas instant.
  // `url` est inclus pour propager les navigations webview (did-navigate →
  // commit store → prop).
  (prev, next) =>
    prev.shape.id === next.shape.id &&
    prev.shape.props.url === next.shape.props.url &&
    prev.shape.props.projectId === next.shape.props.projectId
)

function BrowserShapeView({ shape }: { shape: BrowserShape }) {
  const editor = useEditor()
  const projects = useProjectStore((s) => s.projects)
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)

  const assignedProject = projects.find((p) => p.id === shape.props.projectId) ?? null

  const borderState = useShapeBorderState(shape.id)
  const borderStyle = getShapeBorderStyle(borderState, assignedProject?.color ?? null)

  function setProjectId(projectId: string | null): void {
    editor.updateShape<BrowserShape>({
      id: shape.id,
      type: 'browser',
      props: { projectId }
    })
    setProjectDropdownOpen(false)
  }

  const stopInteractive = {
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
      <BrowserHeader
        shape={shape}
        assignedProject={assignedProject}
        stopInteractive={stopInteractive}
        projectDropdownOpen={projectDropdownOpen}
        setProjectDropdownOpen={setProjectDropdownOpen}
        setProjectId={setProjectId}
        projects={projects}
      />
      <BrowserWebview shape={shape} />
    </div>
  )
}

// Header : barre de navigation (back / forward / reload / URL) + badge projet.
function BrowserHeader({
  shape,
  assignedProject,
  stopInteractive,
  projectDropdownOpen,
  setProjectDropdownOpen,
  setProjectId,
  projects
}: {
  shape: BrowserShape
  assignedProject: { id: string; name: string; color: string } | null
  stopInteractive: StopInteractiveProps
  projectDropdownOpen: boolean
  setProjectDropdownOpen: (fn: (v: boolean) => boolean) => void
  setProjectId: (id: string | null) => void
  projects: { id: string; name: string; color: string }[]
}) {
  const editor = useEditor()
  // Valeur locale du champ URL : éditable par l'utilisateur sans spammer
  // le store tldraw. Synchronisée depuis `shape.props.url` via le pattern
  // "reset state during render" de React 18 : quand l'URL prop change
  // (did-navigate du webview, spawnBrowserShape externe), on reset le
  // draft en même temps. Évite le cascade re-render d'un useEffect +
  // setState (règle react-hooks/set-state-in-effect du repo).
  const [draft, setDraft] = useState(shape.props.url)
  const [lastSeenUrl, setLastSeenUrl] = useState(shape.props.url)
  if (shape.props.url !== lastSeenUrl) {
    setLastSeenUrl(shape.props.url)
    setDraft(shape.props.url)
  }

  // Lecture réactive du moteur courant : le placeholder (et donc l'UX de
  // l'input) suit instantanément le changement dans Settings sans avoir à
  // recharger la shape.
  const searchEngineId = useUIStore((s) => s.searchEngine)
  const searchEngine = getSearchEngine(searchEngineId)

  const commit = (): void => {
    const resolved = resolveQuery(draft, searchEngine)
    if (resolved === shape.props.url) return
    editor.updateShape<BrowserShape>({
      id: shape.id,
      type: 'browser',
      props: { url: resolved }
    })
  }

  // Actions webview : back / forward / reload exposés via un custom event
  // que `BrowserWebview` écoute sur le slot portail. Permet au header de
  // rester découplé du ref webview (montage indépendant).
  const dispatch = (action: 'back' | 'forward' | 'reload'): void => {
    const slot = document.querySelector<HTMLElement>(
      `[data-shape-portal="${shape.id}"]`
    )
    slot?.dispatchEvent(new CustomEvent('blowworks-browser-action', { detail: action }))
  }

  return (
    <div
      data-shape-header
      // Grille 3 colonnes `[auto | 1fr | auto]` : les colonnes latérales
      // s'auto-dimensionnent sur leurs enfants interactifs (boutons nav à
      // gauche, bouton projet à droite), la colonne centrale reçoit
      // l'input URL centré avec `max-width` borné. Résultat : le RESTE
      // du header (espace vide autour de l'input et entre les boutons)
      // hérite du `pointer-events: none` du parent → reste drag zone pour
      // tldraw → facile de cliquer hors des contrôles pour faire apparaître
      // la bordure bleue de sélection et les handles de resize.
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
        <HeaderIconButton
          title="Retour"
          onClick={() => dispatch('back')}
          stopInteractive={stopInteractive}
        >
          <BackIcon />
        </HeaderIconButton>
        <HeaderIconButton
          title="Avancer"
          onClick={() => dispatch('forward')}
          stopInteractive={stopInteractive}
        >
          <ForwardIcon />
        </HeaderIconButton>
        <HeaderIconButton
          title="Recharger"
          onClick={() => dispatch('reload')}
          stopInteractive={stopInteractive}
        >
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
          // `max-w` borné pour laisser visible le reste du header en drag
          // zone — l'utilisateur peut cliquer à gauche/droite de l'input
          // pour sélectionner la shape sans tomber dans l'input.
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

// User-agent Chrome propre, dérivé de `navigator.userAgent` du renderer
// principal (donc aligné sur la version Chromium réellement embarquée
// par Electron — pas de drift avec les bumps Electron). On retire les
// segments `Electron/x.y.z` et `BlowWorks/x.y.z` qui trahissent le
// runtime : certains services (Claude.ai, Google login OAuth, …)
// détectent ces marqueurs et refusent l'authentification.
// Calculé une seule fois au chargement du module — `navigator.userAgent`
// ne change pas pendant la vie du renderer.
const SPOOFED_WEB_USER_AGENT = navigator.userAgent
  .replace(/\s*BlowWorks\/\S+/g, '')
  .replace(/\s*Electron\/\S+/g, '')
  .trim()

// `<webview>` Electron créé IMPÉRATIVEMENT via `document.createElement` :
// React ne garantit pas l'ordre d'application des attributs JSX, or
// `partition` DOIT être posée AVANT que le webview ne s'attache au DOM
// (Chromium fige la session au moment de l'attach — si `src` est posé
// avant `partition`, le webview ouvre la session par défaut et
// `persist:browser` n'est plus jamais utilisée, d'où des logins /
// cookies non partagés entre shapes). Ici on pose `partition` puis
// `allowpopups` puis `useragent` puis `src`, dans cet ordre, avant
// l'insertion DOM.
//
// Le tag est disponible car `webPreferences.webviewTag = true`
// (voir `src/main/window.ts`). La partition `persist:browser` est
// persistée sur disque (cookies/localStorage) et partagée par TOUTES
// les BrowserShapes — isolée de l'origine du renderer principal.
function BrowserWebview({ shape }: { shape: BrowserShape }) {
  const editor = useEditor()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<HTMLElement | null>(null)
  const lastCommittedUrlRef = useRef<string>(shape.props.url)

  // URL initiale figée à la 1ʳᵉ création du webview — les navigations
  // suivantes passent par `loadURL`, pas par un remount du tag. Sans
  // cette ref, une mise à jour de `shape.props.url` avant le montage
  // déclencherait un recréage complet du webview (perte de session).
  const initialUrlRef = useRef<string>(shape.props.url)

  // Création / destruction du webview au (dé)montage UNIQUEMENT.
  // `useLayoutEffect` pour que le webview existe avant les effets suivants
  // qui attachent les listeners did-navigate / dom-ready.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const wv = document.createElement('webview') as HTMLElement
    // Ordre CRITIQUE : partition / allowpopups / useragent AVANT src.
    // Le `useragent` doit être posé avant l'attach (comme `partition`) :
    // c'est l'UA envoyé sur la toute première requête, sinon Claude.ai
    // et autres détectent l'UA Electron par défaut et bloquent le login.
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
    return () => {
      wv.remove()
      webviewRef.current = null
    }
  }, [])

  // Navigation vers l'URL du store tldraw quand elle change DE L'EXTÉRIEUR
  // (barre d'URL, spawnBrowserShape). On ne re-navigue pas si le changement
  // provient du webview lui-même (`did-navigate` → commit du store →
  // nouvel url identique à `lastCommittedUrlRef`).
  useEffect(() => {
    const wv = webviewRef.current as (HTMLElement & {
      loadURL?: (u: string) => Promise<void>
      getURL?: () => string
    }) | null
    if (!wv) return
    if (shape.props.url === lastCommittedUrlRef.current) return
    lastCommittedUrlRef.current = shape.props.url
    // `loadURL` peut être inexistant tant que le webview n'a pas émis
    // `dom-ready`. Dans ce cas, l'attribut `src` initial est déjà la bonne
    // URL — rien à faire, le webview chargera la bonne page au mount.
    if (typeof wv.loadURL === 'function') {
      wv.loadURL(shape.props.url).catch((err) => {
        console.warn('[browser] loadURL échoué', err)
      })
    }
  }, [shape.props.url])

  // Écoute `did-navigate` / `did-navigate-in-page` pour synchroniser l'URL
  // persistée dans tldraw avec l'URL réelle du webview (clic sur un lien,
  // redirect serveur, etc.). Sans ça, la barre d'URL reste figée sur
  // l'ancienne valeur et le reload de l'app reviendrait à la mauvaise page.
  const commitNavigatedUrl = useCallback(
    (url: string): void => {
      if (!url || url === shape.props.url) return
      lastCommittedUrlRef.current = url
      editor.updateShape<BrowserShape>({
        id: shape.id,
        type: 'browser',
        props: { url }
      })
    },
    [editor, shape.id, shape.props.url]
  )

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onNavigate = (e: Event): void => {
      const ev = e as Event & { url?: string }
      if (typeof ev.url === 'string') commitNavigatedUrl(ev.url)
    }
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [commitNavigatedUrl])

  // Masque la scrollbar de la page chargée dans le webview pour une UX
  // immersive cohérente avec le reste de BlowWorks (chat, terminaux,
  // VSCode n'affichent pas non plus de scrollbar système). Scroll natif
  // conservé (roulette, touchpad, clavier). Réinjecté à chaque navigation
  // car `did-navigate` recharge un nouveau document qui perd le CSS.
  useEffect(() => {
    const wv = webviewRef.current as (HTMLElement & {
      insertCSS?: (css: string) => Promise<string>
    }) | null
    if (!wv) return
    const hideScrollbarCSS =
      '::-webkit-scrollbar { width: 0 !important; height: 0 !important; background: transparent !important; } ' +
      'html { scrollbar-width: none !important; -ms-overflow-style: none !important; }'
    const inject = (): void => {
      wv.insertCSS?.(hideScrollbarCSS).catch(() => {
        /* webview peut être détruit entre-temps — ignorer */
      })
    }
    // `dom-ready` est fire une seule fois par document ; `did-navigate`
    // couvre les navigations top-level, `did-navigate-in-page` les SPAs
    // qui mutent l'URL sans recharger (pas de rerun nécessaire, mais
    // coût de l'injection négligeable).
    wv.addEventListener('dom-ready', inject)
    wv.addEventListener('did-navigate', inject)
    return () => {
      wv.removeEventListener('dom-ready', inject)
      wv.removeEventListener('did-navigate', inject)
    }
  }, [])

  // Écoute les actions dispatchées par le header (back/forward/reload).
  useEffect(() => {
    const slot = document.querySelector<HTMLElement>(
      `[data-shape-portal="${shape.id}"]`
    )
    if (!slot) return
    const onAction = (e: Event): void => {
      const detail = (e as CustomEvent).detail as 'back' | 'forward' | 'reload'
      const wv = webviewRef.current as (HTMLElement & {
        goBack?: () => void
        goForward?: () => void
        reload?: () => void
        canGoBack?: () => boolean
        canGoForward?: () => boolean
      }) | null
      if (!wv) return
      if (detail === 'back' && wv.canGoBack?.()) wv.goBack?.()
      else if (detail === 'forward' && wv.canGoForward?.()) wv.goForward?.()
      else if (detail === 'reload') wv.reload?.()
    }
    slot.addEventListener('blowworks-browser-action', onAction)
    return () => slot.removeEventListener('blowworks-browser-action', onAction)
  }, [shape.id])

  return (
    <div
      ref={containerRef}
      className="flex-1"
      style={{ minHeight: 0, pointerEvents: 'auto', background: '#fff' }}
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
