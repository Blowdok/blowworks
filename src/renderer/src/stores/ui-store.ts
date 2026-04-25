import { create } from 'zustand'
import type { ShellKindT } from '@shared/ipc-contract.js'
import {
  DEFAULT_SEARCH_ENGINE_ID,
  isSearchEngineId,
  type SearchEngineId
} from '@shared/search-engines.js'

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
  // Dernier shell utilisé par l'utilisateur — nouveau terminal hérite
  // de ce choix. Mis à jour à chaque switch de shell dans un terminal
  // existant. Évite de refaire manuellement `powershell → pwsh` à
  // chaque spawn.
  lastShell: ShellKindT
  setLastShell: (shell: ShellKindT) => void
  // Moteur de recherche par défaut utilisé par BrowserShape (homepage de
  // toute nouvelle shape + résolution des requêtes barre d'URL). L'utilisateur
  // peut le changer dans Settings > Navigateur. Brave par défaut.
  searchEngine: SearchEngineId
  setSearchEngine: (id: SearchEngineId) => void
  hydrate: () => Promise<void>
}

const KEY_SIDEBAR = 'ui.sidebar.collapsed'
const KEY_STYLE_PANEL = 'ui.stylePanel.visible'
const KEY_TOOLBAR = 'ui.toolbar.visible'
const KEY_LAST_SHELL = 'ui.terminal.lastShell'
const KEY_SEARCH_ENGINE = 'browser.searchEngine'

const VALID_SHELLS: readonly ShellKindT[] = ['powershell', 'pwsh', 'cmd', 'bash']

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

async function readShell(key: string, fallback: ShellKindT): Promise<ShellKindT> {
  try {
    const raw = await window.blow.settings.get(key)
    if (raw && (VALID_SHELLS as readonly string[]).includes(raw)) {
      return raw as ShellKindT
    }
    return fallback
  } catch {
    return fallback
  }
}

async function readSearchEngine(key: string, fallback: SearchEngineId): Promise<SearchEngineId> {
  try {
    const raw = await window.blow.settings.get(key)
    return isSearchEngineId(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

function writeBool(key: string, value: boolean): void {
  void window.blow.settings.set(key, value ? '1' : '0').catch(() => {
    /* best-effort, ne bloque pas l'UI */
  })
}

function writeString(key: string, value: string): void {
  void window.blow.settings.set(key, value).catch(() => {
    /* best-effort, ne bloque pas l'UI */
  })
}

export const useUIStore = create<UIState>((set, get) => ({
  hydrated: false,
  sidebarCollapsed: false,
  stylePanelVisible: true,
  toolbarVisible: true,
  lastShell: 'powershell',
  searchEngine: DEFAULT_SEARCH_ENGINE_ID,

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
  setLastShell: (lastShell) => {
    if (get().lastShell === lastShell) return
    set({ lastShell })
    if (get().hydrated) writeString(KEY_LAST_SHELL, lastShell)
  },
  setSearchEngine: (searchEngine) => {
    if (get().searchEngine === searchEngine) return
    set({ searchEngine })
    if (get().hydrated) writeString(KEY_SEARCH_ENGINE, searchEngine)
  },

  hydrate: async () => {
    const [sidebar, stylePanel, toolbar, lastShell, searchEngine] = await Promise.all([
      readBool(KEY_SIDEBAR, false),
      readBool(KEY_STYLE_PANEL, true),
      readBool(KEY_TOOLBAR, true),
      readShell(KEY_LAST_SHELL, 'powershell'),
      readSearchEngine(KEY_SEARCH_ENGINE, DEFAULT_SEARCH_ENGINE_ID)
    ])
    set({
      sidebarCollapsed: sidebar,
      stylePanelVisible: stylePanel,
      toolbarVisible: toolbar,
      lastShell,
      searchEngine,
      hydrated: true
    })
  }
}))
