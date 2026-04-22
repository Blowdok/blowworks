import { create } from 'zustand'

// État UI persisté dans les settings SQLite (via IPC `window.blow.settings`).
// Hydrate() est appelée une fois au mount de l'App ; tout changement
// suivant est automatiquement sauvegardé. Le flag `hydrated` évite d'écrire
// les valeurs par défaut par-dessus les settings disque avant le chargement
// initial.
interface UIState {
  hydrated: boolean
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  stylePanelVisible: boolean
  toggleStylePanel: () => void
  toolbarVisible: boolean
  toggleToolbar: () => void
  hydrate: () => Promise<void>
}

const KEY_SIDEBAR = 'ui.sidebar.collapsed'
const KEY_STYLE_PANEL = 'ui.stylePanel.visible'
const KEY_TOOLBAR = 'ui.toolbar.visible'

async function readBool(key: string, fallback: boolean): Promise<boolean> {
  try {
    const raw = await window.blow.settings.get(key)
    if (raw === '1') return true
    if (raw === '0') return false
    return fallback
  } catch {
    return fallback
  }
}

function writeBool(key: string, value: boolean): void {
  void window.blow.settings.set(key, value ? '1' : '0').catch(() => {
    /* best-effort, ne bloque pas l'UI */
  })
}

export const useUIStore = create<UIState>((set, get) => ({
  hydrated: false,
  sidebarCollapsed: false,
  stylePanelVisible: true,
  toolbarVisible: true,

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    if (get().hydrated) writeBool(KEY_SIDEBAR, next)
  },
  setSidebarCollapsed: (sidebarCollapsed) => {
    set({ sidebarCollapsed })
    if (get().hydrated) writeBool(KEY_SIDEBAR, sidebarCollapsed)
  },
  toggleStylePanel: () => {
    const next = !get().stylePanelVisible
    set({ stylePanelVisible: next })
    if (get().hydrated) writeBool(KEY_STYLE_PANEL, next)
  },
  toggleToolbar: () => {
    const next = !get().toolbarVisible
    set({ toolbarVisible: next })
    if (get().hydrated) writeBool(KEY_TOOLBAR, next)
  },

  hydrate: async () => {
    const [sidebar, stylePanel, toolbar] = await Promise.all([
      readBool(KEY_SIDEBAR, false),
      readBool(KEY_STYLE_PANEL, true),
      readBool(KEY_TOOLBAR, true)
    ])
    set({
      sidebarCollapsed: sidebar,
      stylePanelVisible: stylePanel,
      toolbarVisible: toolbar,
      hydrated: true
    })
  }
}))
