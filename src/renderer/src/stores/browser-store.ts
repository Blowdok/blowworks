import { create } from 'zustand'

// Store pour l'historique et les favoris du navigateur intégré. Données
// globales partagées entre tous les projets et toutes les BrowserShapes,
// alignées avec la table SQLite côté main via les handlers IPC.
//
// Stratégie d'hydratation : on ne hydrate les favoris qu'une fois au boot
// (cache local), puis on écoute le push event `bookmarks.onChanged` pour
// rester synchro entre fenêtres / shapes. L'historique, lui, est lu à la
// demande (panneau dropdown ouvert) — pas de cache global, ça grossirait
// trop vite.

export interface HistoryEntry {
  id: number
  url: string
  title: string
  favicon: string | null
  visitedAt: number
}

export interface BookmarkEntry {
  id: number
  url: string
  title: string
  favicon: string | null
  sortOrder: number
  createdAt: number
}

export interface DownloadEntry {
  id: string
  url: string
  filename: string
  savePath: string
  mimeType: string | null
  totalBytes: number
  receivedBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: number
  endedAt: number | null
}

interface BrowserStoreState {
  hydrated: boolean
  bookmarks: BookmarkEntry[]
  // Set d'URLs bookmarkées pour lookup O(1) côté UI (étoile remplie/vide).
  bookmarkedUrls: Set<string>
  // Téléchargements live (cache côté renderer pour réactivité). Synchro via
  // l'event onProgress + refresh ponctuel à l'ouverture du panneau.
  downloads: DownloadEntry[]
  // Compteur de téléchargements en cours — utilisé par la barre URL pour
  // afficher un badge sur le bouton ⬇️.
  activeDownloadsCount: number
  hydrate: () => Promise<void>
  refreshBookmarks: () => Promise<void>
  refreshDownloads: () => Promise<void>
  toggleBookmark: (input: {
    url: string
    title?: string | null
    favicon?: string | null
  }) => Promise<boolean>
  removeBookmark: (id: number) => Promise<void>
  // Historique : ces helpers passent par l'IPC à la demande, pas de cache.
  // Le renderer appelle `recordVisit` à chaque did-navigate du webview.
  recordVisit: (input: {
    url: string
    title?: string | null
    favicon?: string | null
  }) => Promise<number | null>
  patchVisit: (
    id: number,
    patch: { title?: string; favicon?: string | null }
  ) => Promise<void>
  listHistory: (opts?: {
    limit?: number
    offset?: number
    search?: string
  }) => Promise<HistoryEntry[]>
  deleteHistoryEntry: (id: number) => Promise<void>
  clearHistory: () => Promise<void>
  // Téléchargements
  cancelDownload: (id: string) => Promise<void>
  openDownload: (id: string) => Promise<void>
  showDownloadInFolder: (id: string) => Promise<void>
  clearDownloads: () => Promise<void>
}

function countActive(list: DownloadEntry[]): number {
  return list.filter((d) => d.state === 'progressing').length
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  hydrated: false,
  bookmarks: [],
  bookmarkedUrls: new Set<string>(),
  downloads: [],
  activeDownloadsCount: 0,

  hydrate: async () => {
    if (get().hydrated) return
    await Promise.all([get().refreshBookmarks(), get().refreshDownloads()])
    // Souscription au push event main → renderer pour rester synchro
    // entre les BrowserShapes et entre fenêtres.
    window.blow.browser.bookmarks.onChanged(() => {
      void get().refreshBookmarks()
    })
    // Souscription aux progress events des téléchargements.
    window.blow.browser.downloads.onProgress((payload) => {
      const list = get().downloads
      const idx = list.findIndex((d) => d.id === payload.id)
      let next: DownloadEntry[]
      if (idx >= 0) {
        next = list.slice()
        next[idx] = payload
      } else {
        // Nouveau téléchargement — on l'ajoute en tête (ordre antéchron).
        next = [payload, ...list]
      }
      set({ downloads: next, activeDownloadsCount: countActive(next) })
    })
    set({ hydrated: true })
  },

  refreshBookmarks: async () => {
    try {
      const list = await window.blow.browser.bookmarks.list()
      set({
        bookmarks: list,
        bookmarkedUrls: new Set(list.map((b) => b.url))
      })
    } catch (err) {
      console.warn('[browser-store] refreshBookmarks échoué', err)
    }
  },

  toggleBookmark: async (input) => {
    try {
      const { bookmarked } = await window.blow.browser.bookmarks.toggle(input)
      // Le push event onChanged déclenchera refresh côté store, mais on
      // applique aussi optimistiquement pour ne pas attendre l'aller-retour.
      const next = new Set(get().bookmarkedUrls)
      if (bookmarked) next.add(input.url)
      else next.delete(input.url)
      set({ bookmarkedUrls: next })
      return bookmarked
    } catch (err) {
      console.warn('[browser-store] toggleBookmark échoué', err)
      return false
    }
  },

  removeBookmark: async (id) => {
    try {
      await window.blow.browser.bookmarks.delete(id)
    } catch (err) {
      console.warn('[browser-store] removeBookmark échoué', err)
    }
  },

  recordVisit: async (input) => {
    try {
      const id = await window.blow.browser.history.record(input)
      return id
    } catch (err) {
      console.warn('[browser-store] recordVisit échoué', err)
      return null
    }
  },

  patchVisit: async (id, patch) => {
    try {
      await window.blow.browser.history.patch({ id, ...patch })
    } catch (err) {
      console.warn('[browser-store] patchVisit échoué', err)
    }
  },

  listHistory: async (opts) => {
    try {
      return await window.blow.browser.history.list(opts)
    } catch (err) {
      console.warn('[browser-store] listHistory échoué', err)
      return []
    }
  },

  deleteHistoryEntry: async (id) => {
    try {
      await window.blow.browser.history.delete(id)
    } catch (err) {
      console.warn('[browser-store] deleteHistoryEntry échoué', err)
    }
  },

  clearHistory: async () => {
    try {
      await window.blow.browser.history.clear()
    } catch (err) {
      console.warn('[browser-store] clearHistory échoué', err)
    }
  },

  refreshDownloads: async () => {
    try {
      const list = await window.blow.browser.downloads.list()
      set({ downloads: list, activeDownloadsCount: countActive(list) })
    } catch (err) {
      console.warn('[browser-store] refreshDownloads échoué', err)
    }
  },

  cancelDownload: async (id) => {
    try {
      await window.blow.browser.downloads.cancel(id)
    } catch (err) {
      console.warn('[browser-store] cancelDownload échoué', err)
    }
  },

  openDownload: async (id) => {
    try {
      await window.blow.browser.downloads.open(id)
    } catch (err) {
      console.warn('[browser-store] openDownload échoué', err)
    }
  },

  showDownloadInFolder: async (id) => {
    try {
      await window.blow.browser.downloads.showInFolder(id)
    } catch (err) {
      console.warn('[browser-store] showDownloadInFolder échoué', err)
    }
  },

  clearDownloads: async () => {
    try {
      await window.blow.browser.downloads.clear()
      await get().refreshDownloads()
    } catch (err) {
      console.warn('[browser-store] clearDownloads échoué', err)
    }
  }
}))
