import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../stores/ui-store.js'
import { useEditorStore } from '../stores/editor-store.js'
import {
  spawnTerminalShape,
  spawnVSCodeShape,
  spawnChatShape,
  spawnBrowserShape
} from './canvas/InfiniteCanvas.js'
import { AI_SERVICES, type AIService } from '@shared/ai-services.js'

// Barre supérieure : drag region native + actions rapides + branding.
// Regroupe toutes les actions globales (nouveau terminal, toggle styles, pages)
// pour garder le canvas tldraw épuré.
export default function Header() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const stylePanelVisible = useUIStore((s) => s.stylePanelVisible)
  const toggleStylePanel = useUIStore((s) => s.toggleStylePanel)
  const toolbarVisible = useUIStore((s) => s.toolbarVisible)
  const toggleToolbar = useUIStore((s) => s.toggleToolbar)
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

  function handleSpawnAI(service: AIService): void {
    if (!editor) return
    // `spawnBrowserShape(editor, url)` accepte une URL libre — on lui
    // passe la homepage du service. Le webview gère l'auth via la
    // partition `persist:browser` partagée (login persistant).
    spawnBrowserShape(editor, service.homepage)
    setAIMenuOpen(false)
  }

  // État du menu déroulant "IA". Click extérieur / Échap referme.
  const [aiMenuOpen, setAIMenuOpen] = useState(false)
  const aiMenuWrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!aiMenuOpen) return
    function onMouseDown(e: MouseEvent): void {
      if (aiMenuWrapperRef.current?.contains(e.target as Node)) return
      setAIMenuOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setAIMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [aiMenuOpen])

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

        {/* Bouton IA + menu déroulant : spawne une BrowserShape sur la
            homepage du service choisi. Tous les services sont rendus
            dans le même webview Electron — login partagé entre eux. */}
        <div ref={aiMenuWrapperRef} className="relative">
          <button
            type="button"
            onClick={() => setAIMenuOpen((v) => !v)}
            disabled={!editor}
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              color: aiMenuOpen ? activeColor : inactiveColor,
              background: aiMenuOpen ? 'var(--bg-tertiary)' : undefined
            }}
            title="Lancer un assistant IA"
            aria-haspopup="menu"
            aria-expanded={aiMenuOpen}
          >
            <SparkIcon />
            <span>IA</span>
            <ChevronDownIcon open={aiMenuOpen} />
          </button>
          {aiMenuOpen && (
            <div
              role="menu"
              aria-label="Choisir un assistant IA"
              className="absolute left-0 top-full z-50 mt-1 flex min-w-[260px] flex-col rounded-[var(--radius-sm)] border p-1 shadow-2xl"
              style={{
                background: 'var(--bg-secondary)',
                borderColor: 'var(--border)'
              }}
            >
              {AI_SERVICES.map((svc) => (
                <button
                  key={svc.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleSpawnAI(svc)}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                    style={{ background: svc.color }}
                    aria-hidden
                  >
                    {svc.label[0]}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[var(--fg-primary)]">
                      {svc.label}
                    </span>
                    <span className="truncate text-[10px] text-[var(--fg-muted)]">
                      {svc.tagline}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

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

        <button
          type="button"
          onClick={toggleStylePanel}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
          style={{
            color: stylePanelVisible ? 'var(--fg-secondary)' : 'var(--fg-muted)'
          }}
          title={
            stylePanelVisible
              ? 'Masquer le panneau de styles'
              : 'Afficher le panneau de styles'
          }
          aria-pressed={stylePanelVisible}
        >
          <PaletteIcon />
          <span>Styles</span>
        </button>

        <button
          type="button"
          onClick={toggleToolbar}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] px-2.5 py-1 font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
          style={{
            color: toolbarVisible ? 'var(--fg-secondary)' : 'var(--fg-muted)'
          }}
          title={
            toolbarVisible
              ? 'Masquer la barre d’outils (Alt+T)'
              : 'Afficher la barre d’outils (Alt+T)'
          }
          aria-pressed={toolbarVisible}
        >
          <WrenchIcon />
          <span>Outils</span>
        </button>

      </nav>

      {/* Zone droite : meta */}
      <div className="flex justify-end">
        <span className="rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--fg-muted)]">
          v1.0.0
        </span>
      </div>
    </header>
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

// Icône « Outils » pour le toggle de la toolbar tldraw. Clé à molette
// simplifiée, cohérente avec le style SVG 14×14 stroke-based des autres
// icônes custom du Header (PaletteIcon, WrenchIcon, etc.).
function WrenchIcon() {
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
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

function SparkIcon() {
  // Étincelle 4 branches : symbole IA générique, neutre vis-à-vis des
  // marques (chacun a son icône dans le menu déroulant).
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
      <path d="M12 3 L13.5 9 L19.5 10.5 L13.5 12 L12 18 L10.5 12 L4.5 10.5 L10.5 9 Z" />
      <path d="M19 17 L19.6 19 L21.5 19.5 L19.6 20 L19 22 L18.4 20 L16.5 19.5 L18.4 19 Z" />
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

function PaletteIcon() {
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
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  )
}

