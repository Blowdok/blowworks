import { create } from 'zustand'

// État global des overlays « chrome » de l'app (palette de commandes,
// modale Paramètres). Centralisé ici pour que la palette puisse ouvrir
// Settings sans passer par la Sidebar.
export type SettingsTab =
  | 'openrouter'
  | 'tavily'
  | 'defaults'
  | 'wiki'
  | 'agents'
  | 'browser'
  | 'canvas'
  | 'terminal'

interface AppChromeState {
  commandPaletteOpen: boolean
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleCommandPalette: () => void
  settingsOpen: boolean
  settingsInitialTab: SettingsTab | undefined
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
}

export const useAppChromeStore = create<AppChromeState>((set) => ({
  commandPaletteOpen: false,
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  settingsOpen: false,
  settingsInitialTab: undefined,
  openSettings: (tab) =>
    set({ settingsOpen: true, settingsInitialTab: tab }),
  closeSettings: () =>
    set({ settingsOpen: false, settingsInitialTab: undefined })
}))
