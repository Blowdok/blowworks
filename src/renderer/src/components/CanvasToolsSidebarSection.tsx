import { useUIStore } from '../stores/ui-store.js'

// Section « Tools Canvas » de la Sidebar — regroupe les toggles
// d'éléments natifs tldraw (panneau de styles, barre d'outils du bas)
// pour libérer de la place dans le Header de l'app.
//
// Avant : deux boutons Styles + Outils dans la zone centrale du Header.
// Après : section dédiée dans la sidebar, à côté de Mémoire et Graph.
// Cohérent avec l'esprit "Header pour les actions de création (Terminal,
// VSCode, Chat, boutons custom), Sidebar pour la configuration de la
// vue".
//
// L'état `stylePanelVisible` / `toolbarVisible` est déjà persisté dans
// SQLite settings via `useUIStore` — pas de duplication ici.

interface CanvasToolsSidebarSectionProps {
  collapsed: boolean
}

export default function CanvasToolsSidebarSection({
  collapsed
}: CanvasToolsSidebarSectionProps): React.ReactElement {
  const stylePanelVisible = useUIStore((s) => s.stylePanelVisible)
  const toggleStylePanel = useUIStore((s) => s.toggleStylePanel)
  const toolbarVisible = useUIStore((s) => s.toolbarVisible)
  const toggleToolbar = useUIStore((s) => s.toggleToolbar)

  // Mode sidebar collapsed : icônes seules, alignées verticalement.
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-2">
        <button
          type="button"
          onClick={toggleStylePanel}
          className="rounded-[var(--radius-sm)] border px-2 py-1 text-[12px]"
          style={{
            borderColor: stylePanelVisible ? 'var(--fg-secondary)' : 'var(--border)',
            color: stylePanelVisible ? 'var(--fg-secondary)' : 'var(--fg-muted)',
            background: stylePanelVisible ? 'var(--bg-tertiary)' : 'transparent'
          }}
          title={
            stylePanelVisible
              ? 'Masquer le panneau de styles'
              : 'Afficher le panneau de styles'
          }
          aria-pressed={stylePanelVisible}
        >
          <PaletteIcon />
        </button>
        <button
          type="button"
          onClick={toggleToolbar}
          className="rounded-[var(--radius-sm)] border px-2 py-1 text-[12px]"
          style={{
            borderColor: toolbarVisible ? 'var(--fg-secondary)' : 'var(--border)',
            color: toolbarVisible ? 'var(--fg-secondary)' : 'var(--fg-muted)',
            background: toolbarVisible ? 'var(--bg-tertiary)' : 'transparent'
          }}
          title={
            toolbarVisible
              ? 'Masquer la barre d’outils (Alt+T)'
              : 'Afficher la barre d’outils (Alt+T)'
          }
          aria-pressed={toolbarVisible}
        >
          <WrenchIcon />
        </button>
      </div>
    )
  }

  // Mode sidebar dépliée : titre uppercase + liste verticale de toggles
  // avec libellé (cohérent avec Memory et Graph sections).
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
        Tools Canvas
      </h3>
      <div className="flex flex-col gap-1">
        <ToggleRow
          icon={<PaletteIcon />}
          label="Panneau de styles"
          active={stylePanelVisible}
          onToggle={toggleStylePanel}
          activeTitle="Masquer le panneau de styles tldraw"
          inactiveTitle="Afficher le panneau de styles tldraw"
        />
        <ToggleRow
          icon={<WrenchIcon />}
          label="Barre d’outils"
          shortcut="Alt+T"
          active={toolbarVisible}
          onToggle={toggleToolbar}
          activeTitle="Masquer la barre d’outils tldraw (Alt+T)"
          inactiveTitle="Afficher la barre d’outils tldraw (Alt+T)"
        />
      </div>
    </div>
  )
}

function ToggleRow({
  icon,
  label,
  shortcut,
  active,
  onToggle,
  activeTitle,
  inactiveTitle
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  active: boolean
  onToggle: () => void
  activeTitle: string
  inactiveTitle: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={active ? activeTitle : inactiveTitle}
      className="flex items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-tertiary)]"
      style={{
        borderColor: active ? 'var(--fg-secondary)' : 'var(--border)',
        color: active ? 'var(--fg-secondary)' : 'var(--fg-muted)',
        background: active ? 'var(--bg-tertiary)' : 'transparent'
      }}
    >
      <span aria-hidden className="flex h-4 w-4 items-center justify-center">
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="text-[9px] text-[var(--fg-muted)]">{shortcut}</span>
      )}
    </button>
  )
}

// Icônes locales (mêmes SVG que dans Header.tsx — copiées plutôt que
// d'exporter depuis Header pour éviter un import croisé qui réintroduit
// les responsabilités UI du header dans la sidebar).
function PaletteIcon(): React.ReactElement {
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
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  )
}

function WrenchIcon(): React.ReactElement {
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
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}
