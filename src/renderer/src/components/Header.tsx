import { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '../stores/ui-store.js'
import { useEditorStore } from '../stores/editor-store.js'
import {
  spawnTerminalShape,
  spawnVSCodeShape,
  spawnChatShape,
  spawnBrowserShape
} from './canvas/InfiniteCanvas.js'
import { useHeaderButtonsStore } from '../stores/header-buttons-store.js'
import type {
  HeaderButton,
  HeaderButtonEntry,
  HeaderButtonItem
} from '@shared/header-buttons.js'

// Barre supérieure : drag region native + actions rapides + branding.
// Regroupe les actions de création (Terminal, VSCode, Chat, boutons custom
// Navigateur) pour garder le canvas tldraw épuré. Les toggles d'éléments
// natifs tldraw (panneau de styles, barre d'outils) sont dans la sidebar
// à la section "Tools Canvas".
export default function Header() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const editor = useEditorStore((s) => s.editor)

  // Compteurs par type de shape portail (toutes pages confondues). Sert
  // à colorer le libellé de chaque bouton en cyan dès qu'au moins une
  // instance de ce type existe dans le projet, sinon en gris muted —
  // l'utilisateur voit d'un coup d'œil quelles catégories d'artefacts
  // sont présentes sur son canvas.
  //
  // Pattern `editor.store.listen` calqué sur `TabsBar.tsx` : plus fiable
  // que `useValue` tldraw dans un composant rendu HORS du contexte
  // <Tldraw> (le Header vit au niveau App, pas dans le canvas).
  const [shapeCounts, setShapeCounts] = useState({
    terminal: 0,
    vscode: 0,
    chat: 0,
    browser: 0
  })

  useEffect(() => {
    if (!editor) return
    const recompute = (): void => {
      // `validPageIds` = pages encore présentes dans le store. Filtre
      // CRUCIAL : un snapshot tldraw restauré peut contenir des shapes
      // dont le `parentId` pointe vers une page supprimée, ou vers un
      // groupe effacé. Ces shapes restent dans `allRecords()` mais ne
      // sont PAS visibles à l'utilisateur — les compter donnerait de
      // faux positifs (bouton qui reste cyan sans aucun artefact visible).
      const validPageIds = new Set<string>(
        editor.getPages().map((p) => p.id as string)
      )
      let terminal = 0
      let vscode = 0
      let chat = 0
      let browser = 0
      for (const record of editor.store.allRecords()) {
        if (record.typeName !== 'shape') continue
        const shape = record as { type: string; parentId: string }
        if (!validPageIds.has(shape.parentId)) continue
        if (shape.type === 'terminal') terminal++
        else if (shape.type === 'vscode') vscode++
        else if (shape.type === 'chat') chat++
        else if (shape.type === 'browser') browser++
      }
      setShapeCounts((prev) =>
        prev.terminal === terminal &&
        prev.vscode === vscode &&
        prev.chat === chat &&
        prev.browser === browser
          ? prev
          : { terminal, vscode, chat, browser }
      )
    }
    recompute()
    // Pas de filtre scope — les shapes vivent dans `document`, mais un
    // create/delete peut arriver par n'importe quelle source utilisateur
    // ou snapshot restore. Écouter sans filtre évite les faux négatifs.
    const dispose = editor.store.listen(recompute)
    return dispose
  }, [editor])

  // Couleur active/inactive identique à celle du bouton Styles non
  // activé → cohérence visuelle demandée par l'utilisateur.
  const activeColor = 'var(--fg-secondary)'
  const inactiveColor = 'var(--fg-muted)'

  function handleNewTerminal(): void {
    if (editor) spawnTerminalShape(editor)
  }

  async function handleNewVSCode(): Promise<void> {
    if (!editor) return
    const folder = await window.blow.dialog.pickFolder({
      title: 'Sélectionner un dossier à ouvrir dans VSCode'
    })
    if (!folder) return
    spawnVSCodeShape(editor, folder)
  }

  async function handleNewChat(): Promise<void> {
    if (!editor) return
    await spawnChatShape(editor)
  }

  function handleNewBrowser(): void {
    if (editor) spawnBrowserShape(editor)
  }

  // Boutons custom du Header (configurables depuis Settings > Navigateur).
  // Chaque bouton ouvre une BrowserShape sur l'URL de l'item choisi.
  // L'état d'ouverture du menu déroulant est local au composant (un
  // bouton ouvert à la fois) — clé `null` = aucun menu ouvert.
  const headerButtons = useHeaderButtonsStore((s) => s.buttons)

  return (
    <header className="drag-region grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[var(--fg-primary)]">
      {/* Zone gauche : sidebar + brand + pages */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleSidebar}
          className="no-drag rounded-[var(--radius-sm)] px-2 py-1 text-sm text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          aria-label="Afficher/masquer la barre latérale"
          title="Barre latérale"
        >
          ☰
        </button>
        <span className="select-none font-semibold tracking-wide">
          Blow<span className="text-[var(--fg-secondary)]">Works</span>
        </span>
        <TldrawMenuZoneSlot />
      </div>

      {/* Zone centrale : actions principales */}
      <nav className="no-drag flex items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={handleNewTerminal}
          disabled={!editor}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: shapeCounts.terminal > 0 ? activeColor : inactiveColor }}
          title="Créer un terminal (Ctrl+T)"
        >
          <PlusIcon />
          <span>Terminal</span>
          {shapeCounts.terminal > 0 && (
            <span
              className="rounded px-1 text-[10px] text-[var(--fg-muted)]"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {shapeCounts.terminal}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => void handleNewVSCode()}
          disabled={!editor}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: shapeCounts.vscode > 0 ? activeColor : inactiveColor }}
          title="Ouvrir un dossier dans VSCode"
        >
          <VSCodeIcon />
          <span>VSCode</span>
          {shapeCounts.vscode > 0 && (
            <span
              className="rounded px-1 text-[10px] text-[var(--fg-muted)]"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {shapeCounts.vscode}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => void handleNewChat()}
          disabled={!editor}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: shapeCounts.chat > 0 ? activeColor : inactiveColor }}
          title="Nouvelle conversation IA (Ctrl+K)"
        >
          <ChatIcon />
          <span>Chat</span>
          {shapeCounts.chat > 0 && (
            <span
              className="rounded px-1 text-[10px] text-[var(--fg-muted)]"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {shapeCounts.chat}
            </span>
          )}
        </button>

        {/* Boutons custom configurables depuis Settings > Navigateur.
            Chaque bouton ouvre un arbre `entries` qui peut contenir des
            URLs terminales (items) ou des dossiers (récursif, profondeur
            illimitée) :
              • 0 entry          → bouton désactivé (à configurer)
              • 1 entry item     → clic = spawn direct (pas de menu)
              • sinon            → menu cascading : dossiers s'expandent
                                   en sous-menu à droite au survol/clic
            Login persistant via la partition `persist:browser` du
            webview Electron (cookies partagés entre tous les boutons). */}
        {headerButtons.map((btn) => (
          <HeaderCustomButton
            key={btn.id}
            button={btn}
            disabled={!editor}
            inactiveColor={inactiveColor}
            activeColor={activeColor}
            onSpawn={(item) => {
              if (!editor) return
              spawnBrowserShape(editor, item.url)
            }}
          />
        ))}

        <button
          type="button"
          onClick={handleNewBrowser}
          disabled={!editor}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: shapeCounts.browser > 0 ? activeColor : inactiveColor }}
          title="Nouveau navigateur web (Ctrl+B)"
        >
          <GlobeIcon />
          <span>Navigateur</span>
          {shapeCounts.browser > 0 && (
            <span
              className="rounded px-1 text-[10px] text-[var(--fg-muted)]"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {shapeCounts.browser}
            </span>
          )}
        </button>

      </nav>

      {/* Zone droite : meta */}
      <div className="flex justify-end">
        <span className="rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--fg-muted)]">
          v{__APP_VERSION__}
        </span>
      </div>
    </header>
  )
}

// Bouton header configurable. Affiche un libellé + pastille colorée et
// selon le contenu :
//   • 0 entry           → désactivé, tooltip "à configurer".
//   • 1 entry item      → clic = spawn direct (pas de menu).
//   • sinon             → menu déroulant en DRILL-DOWN : items au clic,
//                         dossiers remplacent la vue par leurs enfants
//                         (avec bouton ← Retour pour remonter d'un cran).
// Cohérent avec le style du menu contextuel canvas. Click extérieur /
// Échap referme le menu et remet le drill-down à la racine.
function HeaderCustomButton({
  button,
  disabled,
  inactiveColor,
  activeColor,
  onSpawn
}: {
  button: HeaderButton
  disabled: boolean
  inactiveColor: string
  activeColor: string
  onSpawn: (item: HeaderButtonItem) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  // Stack d'ids de dossiers traversés pour atteindre la vue courante du
  // drill-down. Vide = on est à la racine du bouton (entries directs).
  // Reset à `[]` à chaque (ré)ouverture du menu pour repartir d'un état
  // propre — sinon réouvrir tomberait sur le sous-dossier de la session
  // précédente, ce qui désoriente.
  const [path, setPath] = useState<string[]>([])
  const wrapperRef = useRef<HTMLDivElement>(null)
  const entryCount = button.entries.length
  // Premier item terminal de premier niveau (utilisé pour le mode "clic
  // direct" quand le bouton n'a qu'une seule entrée et que c'est un item).
  const onlyEntry = entryCount === 1 ? button.entries[0] : null
  const directShortcut = onlyEntry && onlyEntry.kind === 'item' ? onlyEntry : null
  // Si l'unique entrée est un dossier, on ouvre quand même le menu (pas
  // de clic direct possible — un dossier n'a pas d'URL).
  const hasMenu = entryCount > 1 || (entryCount === 1 && !directShortcut)

  // Wrapper de fermeture : reset le drill-down à la racine en MÊME temps
  // que la fermeture, pour que la prochaine ouverture parte d'un état
  // propre sans avoir besoin d'un effect réactif (évite le pattern
  // anti-pattern "setState dans un useEffect dépendant du même state").
  const closeMenu = useCallback(() => {
    setOpen(false)
    setPath([])
  }, [])

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      const target = e.target as Node | null
      if (!target) return
      if (wrapperRef.current?.contains(target)) return
      closeMenu()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closeMenu])

  const isDisabled = disabled || entryCount === 0
  const initial = button.label.trim()[0]?.toUpperCase() ?? '?'
  const title =
    entryCount === 0
      ? `${button.label} — aucun item (configurer dans Réglages > Navigateur)`
      : directShortcut
        ? `${button.label} — ${directShortcut.label}`
        : `${button.label} (${entryCount} entrées)`

  function handleClick(): void {
    if (isDisabled) return
    if (hasMenu) {
      if (open) closeMenu()
      else setOpen(true)
      return
    }
    if (directShortcut) onSpawn(directShortcut)
  }

  // Résout la vue courante du drill-down (entries + titre) à partir du
  // path. Si un id du path est invalide (dossier supprimé pendant que le
  // menu est ouvert, par exemple), on s'arrête au dernier dossier valide
  // — comportement gracieux, pas de crash.
  let currentEntries: readonly HeaderButtonEntry[] = button.entries
  let currentTitle = button.label
  for (const folderId of path) {
    const folder = currentEntries.find(
      (e): e is HeaderButtonEntry & { kind: 'folder' } =>
        e.kind === 'folder' && e.id === folderId
    )
    if (!folder) break
    currentEntries = folder.children
    currentTitle = folder.label
  }
  const isAtRoot = path.length === 0

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          color: open ? activeColor : inactiveColor,
          background: open ? 'var(--bg-tertiary)' : undefined
        }}
        title={title}
        aria-haspopup={hasMenu ? 'menu' : undefined}
        aria-expanded={hasMenu ? open : undefined}
      >
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
          style={{ background: button.color }}
        >
          {initial}
        </span>
        <span>{button.label}</span>
        {hasMenu && <ChevronDownIcon open={open} />}
      </button>
      {hasMenu && open && (
        <div
          role="menu"
          aria-label={`Choisir une entrée ${button.label}`}
          className="absolute left-0 top-full z-50 mt-1 flex min-w-[260px] flex-col rounded-[var(--radius-sm)] border p-1 shadow-2xl"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border)'
          }}
        >
          {/* Bouton ← Retour : remonte d'un cran dans le drill-down. À la
              racine, ferme directement le menu. Le label affiché est le
              titre courant (label du bouton à la racine, label du dossier
              parent quand on est dans un dossier) — donne un repère
              visuel de l'arborescence. */}
          <button
            type="button"
            onClick={() => {
              if (isAtRoot) {
                closeMenu()
              } else {
                setPath(path.slice(0, -1))
              }
            }}
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-left text-[10px] uppercase tracking-widest text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
            title={isAtRoot ? 'Fermer' : 'Retour'}
          >
            <span aria-hidden>←</span>
            <span className="truncate">{currentTitle}</span>
          </button>
          <div className="my-0.5 h-px" style={{ background: 'var(--border)' }} />
          <DrillDownEntries
            entries={currentEntries}
            color={button.color}
            onPickItem={(item) => {
              onSpawn(item)
              closeMenu()
            }}
            onPickFolder={(folderId) => setPath([...path, folderId])}
          />
        </div>
      )}
    </div>
  )
}

// Liste des entrées d'un niveau du drill-down du Header. Items =
// boutons qui spawn la BrowserShape ; dossiers = boutons avec ▸ qui
// poussent leur id dans la stack du menu pour faire défiler la vue
// vers leurs enfants. Cohérent avec `SitesEntries` du menu contextuel
// canvas.
function DrillDownEntries({
  entries,
  color,
  onPickItem,
  onPickFolder
}: {
  entries: readonly HeaderButtonEntry[]
  color: string
  onPickItem: (item: HeaderButtonItem) => void
  onPickFolder: (folderId: string) => void
}): React.ReactElement {
  if (entries.length === 0) {
    return (
      <div className="px-2 py-1.5 text-[11px] italic text-[var(--fg-muted)]">
        (vide)
      </div>
    )
  }
  return (
    <>
      {entries.map((entry) =>
        entry.kind === 'item' ? (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            onClick={() => onPickItem(entry)}
            className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-tertiary)]"
            title={entry.url}
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{ background: color }}
              aria-hidden
            >
              {entry.label[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[var(--fg-primary)]">{entry.label}</span>
              {entry.tagline && (
                <span className="truncate text-[10px] text-[var(--fg-muted)]">
                  {entry.tagline}
                </span>
              )}
            </span>
          </button>
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            onClick={() => onPickFolder(entry.id)}
            className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[12px]"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--fg-muted)'
              }}
              aria-hidden
            >
              📁
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[var(--fg-primary)]">{entry.label}</span>
              <span className="truncate text-[10px] text-[var(--fg-muted)]">
                {entry.children.length === 0
                  ? '(vide)'
                  : `${entry.children.length} entrée${entry.children.length > 1 ? 's' : ''}`}
              </span>
            </span>
            <span aria-hidden className="text-[var(--fg-muted)]">
              ›
            </span>
          </button>
        )
      )}
    </>
  )
}

// Slot qui ADOPTE physiquement la barre native tldraw (`.tlui-menu-zone`)
// — contenant le Main Menu (hamburger) et le Page Menu — pour la déplacer
// hors du canvas vers le Header.
//
// On utilise `appendChild` au lieu d'un portail React : ça préserve les
// références internes de Radix UI (dropdown portal + floating-ui), donc tous
// les popovers continuent de se positionner correctement via `getBoundingClientRect`.
//
// RÉ-ADOPTION PERMANENTE via MutationObserver : certains toggles tldraw
// (notamment "Mode focus" du main menu) RE-CRÉENT la menu-zone dans le
// coin haut-gauche du canvas. Sans ré-adoption, l'ancienne instance
// (déjà déplacée dans le header) devient orpheline et cesse de répondre
// aux clics, pendant qu'une nouvelle instance apparaît dans le canvas →
// duplication visible + barre du header cassée. L'observer détecte
// chaque nouvelle apparition hors du slot et la ré-adopte, en
// supprimant au passage les anciennes orphelines.
function TldrawMenuZoneSlot() {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const editor = useEditorStore((s) => s.editor)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  useEffect(() => {
    if (!editor || !slotRef.current) return
    const slot = slotRef.current
    let originalParent: HTMLElement | null = null
    let observer: MutationObserver | null = null
    let containerPoll: number | null = null
    let rafId: number | null = null

    const adopt = (): void => {
      rafId = null
      const zones = Array.from(
        document.querySelectorAll<HTMLElement>('.tlui-menu-zone')
      )
      // Toute instance hors du slot est soit la "live" (React-bound) qui
      // vient d'être créée, soit un doublon orphelin. La plus récente
      // rendue par React est toujours la "vraie" → on remplace ce qu'on
      // a par la première outsider trouvée, on supprime les autres.
      const outsiders = zones.filter((z) => z.parentElement !== slot)
      if (outsiders.length === 0) return
      const target = outsiders[0]
      if (!originalParent && target.parentElement) {
        originalParent = target.parentElement
      }
      // Vider le slot (ancienne instance devenue orpheline après toggle
      // focus / re-render tldraw) AVANT d'adopter la nouvelle.
      while (slot.firstChild) slot.removeChild(slot.firstChild)
      slot.appendChild(target)
      // Toute autre instance en doublon est retirée pour éviter la
      // duplication visuelle dans le coin du canvas.
      outsiders.slice(1).forEach((z) => z.remove())
    }

    const scheduleAdopt = (): void => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(adopt)
    }

    const attachObserver = (): boolean => {
      // Cibler le container tldraw : observer un sous-arbre restreint
      // évite les notifications de mutation sur tout le document.
      const container = document.querySelector<HTMLElement>('.tl-container')
      if (!container) return false
      observer = new MutationObserver(scheduleAdopt)
      observer.observe(container, { childList: true, subtree: true })
      // Adoption initiale synchrone au cas où la menu-zone existe déjà.
      scheduleAdopt()
      return true
    }

    if (!attachObserver()) {
      containerPoll = window.setInterval(() => {
        if (attachObserver()) {
          if (containerPoll !== null) {
            window.clearInterval(containerPoll)
            containerPoll = null
          }
        }
      }, 50)
    }

    return () => {
      if (containerPoll !== null) window.clearInterval(containerPoll)
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (observer) observer.disconnect()
      // Remise en place pour éviter un crash React/tldraw en cas de HMR.
      const current = slot.querySelector<HTMLElement>('.tlui-menu-zone')
      if (current && originalParent) {
        originalParent.appendChild(current)
      }
    }
  }, [editor])

  // Aligne le slot sur le bord droit de la sidebar pour éviter la collision
  // avec le nom de l'app. Sidebar ouverte = 240px, collapsed = 64px. On
  // retranche la largeur approximative de "☰ BlowWorks" (~148px) pour
  // positionner le slot juste après.
  const marginLeft = sidebarCollapsed ? 0 : 96

  return (
    <div
      ref={slotRef}
      className="no-drag flex items-center transition-[margin] duration-150"
      style={{ marginLeft }}
    />
  )
}

// ──────────────────────────────────────────────────────────── Icônes SVG inline

function PlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function VSCodeIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: open ? 'rotate(180deg)' : undefined,
        transition: 'transform 120ms ease-out'
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

