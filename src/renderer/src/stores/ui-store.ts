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
  // Fond du canvas tldraw : image custom centrée à (0,0), suit la caméra.
  // dataUrl = string base64 (data:image/...;base64,...) ou null si désactivé.
  // opacity = 0..1 ; size = côté carré en pixels (centré sur l'origine).
  canvasBgDataUrl: string | null
  canvasBgOpacity: number
  canvasBgSize: number
  setCanvasBgDataUrl: (url: string | null) => void
  setCanvasBgOpacity: (v: number) => void
  setCanvasBgSize: (v: number) => void
  // Dossier de travail par défaut des nouveaux terminaux. Chaîne vide →
  // le main résout Bureau puis home au spawn du PTY.
  defaultTerminalCwd: string
  setDefaultTerminalCwd: (path: string) => void
  hydrate: () => Promise<void>
}

const KEY_SIDEBAR = 'ui.sidebar.collapsed'
const KEY_STYLE_PANEL = 'ui.stylePanel.visible'
const KEY_TOOLBAR = 'ui.toolbar.visible'
const KEY_LAST_SHELL = 'ui.terminal.lastShell'
const KEY_SEARCH_ENGINE = 'browser.searchEngine'
const KEY_CANVAS_BG_DATAURL = 'canvas.background.dataUrl'
const KEY_CANVAS_BG_OPACITY = 'canvas.background.opacity'
const KEY_CANVAS_BG_SIZE = 'canvas.background.size'
const KEY_TERMINAL_DEFAULT_CWD = 'ui.terminal.defaultCwd'

const DEFAULT_CANVAS_BG_OPACITY = 0.25
const DEFAULT_CANVAS_BG_SIZE = 800

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

async function readNumber(key: string, fallback: number): Promise<number> {
  try {
    const raw = await window.blow.settings.get(key)
    if (raw === null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

async function readMaybeString(key: string): Promise<string | null> {
  try {
    const raw = await window.blow.settings.get(key)
    return raw && raw.length > 0 ? raw : null
  } catch {
    return null
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
  canvasBgDataUrl: null,
  canvasBgOpacity: DEFAULT_CANVAS_BG_OPACITY,
  canvasBgSize: DEFAULT_CANVAS_BG_SIZE,
  defaultTerminalCwd: '',

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
  setCanvasBgDataUrl: (canvasBgDataUrl) => {
    set({ canvasBgDataUrl })
    if (get().hydrated) writeString(KEY_CANVAS_BG_DATAURL, canvasBgDataUrl ?? '')
  },
  setCanvasBgOpacity: (canvasBgOpacity) => {
    const clamped = Math.max(0, Math.min(1, canvasBgOpacity))
    if (get().canvasBgOpacity === clamped) return
    set({ canvasBgOpacity: clamped })
    if (get().hydrated) writeString(KEY_CANVAS_BG_OPACITY, clamped.toString())
  },
  setCanvasBgSize: (canvasBgSize) => {
    const clamped = Math.max(100, Math.min(4000, Math.round(canvasBgSize)))
    if (get().canvasBgSize === clamped) return
    set({ canvasBgSize: clamped })
    if (get().hydrated) writeString(KEY_CANVAS_BG_SIZE, clamped.toString())
  },
  setDefaultTerminalCwd: (defaultTerminalCwd) => {
    if (get().defaultTerminalCwd === defaultTerminalCwd) return
    set({ defaultTerminalCwd })
    if (get().hydrated) writeString(KEY_TERMINAL_DEFAULT_CWD, defaultTerminalCwd)
  },

  hydrate: async () => {
    const [
      sidebar,
      stylePanel,
      toolbar,
      lastShell,
      searchEngine,
      canvasBgDataUrl,
      canvasBgOpacity,
      canvasBgSize,
      defaultTerminalCwd
    ] = await Promise.all([
      readBool(KEY_SIDEBAR, false),
      readBool(KEY_STYLE_PANEL, true),
      readBool(KEY_TOOLBAR, true),
      readShell(KEY_LAST_SHELL, 'powershell'),
      readSearchEngine(KEY_SEARCH_ENGINE, DEFAULT_SEARCH_ENGINE_ID),
      readMaybeString(KEY_CANVAS_BG_DATAURL),
      readNumber(KEY_CANVAS_BG_OPACITY, DEFAULT_CANVAS_BG_OPACITY),
      readNumber(KEY_CANVAS_BG_SIZE, DEFAULT_CANVAS_BG_SIZE),
      readMaybeString(KEY_TERMINAL_DEFAULT_CWD).then((v) => v ?? '')
    ])
    set({
      sidebarCollapsed: sidebar,
      stylePanelVisible: stylePanel,
      toolbarVisible: toolbar,
      lastShell,
      searchEngine,
      canvasBgDataUrl,
      canvasBgOpacity,
      canvasBgSize,
      defaultTerminalCwd,
      hydrated: true
    })
  }
}))
