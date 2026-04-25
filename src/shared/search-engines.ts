// Catalogue des moteurs de recherche supportés par BrowserShape.
// Source unique de vérité partagée entre main / preload / renderer.
//
// Ajouter un moteur = ajouter une entrée à `SEARCH_ENGINES` ; le dropdown
// Settings et le `resolveQuery` du browser le récupèrent automatiquement.

export type SearchEngineId = 'brave' | 'duckduckgo' | 'google' | 'qwant' | 'startpage'

export interface SearchEngine {
  readonly id: SearchEngineId
  readonly label: string
  readonly homepage: string
  // Construit l'URL de recherche pour une requête donnée. La query est
  // déjà décodée (texte brut) — chaque moteur s'occupe de l'encoder.
  readonly buildSearchUrl: (query: string) => string
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    id: 'brave',
    label: 'Brave Search',
    homepage: 'https://search.brave.com/',
    buildSearchUrl: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    homepage: 'https://duckduckgo.com/',
    buildSearchUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`
  },
  {
    id: 'google',
    label: 'Google',
    homepage: 'https://www.google.com/',
    buildSearchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`
  },
  {
    id: 'qwant',
    label: 'Qwant',
    homepage: 'https://www.qwant.com/',
    buildSearchUrl: (q) => `https://www.qwant.com/?q=${encodeURIComponent(q)}`
  },
  {
    id: 'startpage',
    label: 'Startpage',
    homepage: 'https://www.startpage.com/',
    buildSearchUrl: (q) => `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}`
  }
] as const

export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = 'brave'

export function getSearchEngine(id: SearchEngineId | string | null | undefined): SearchEngine {
  const found = SEARCH_ENGINES.find((e) => e.id === id)
  return found ?? SEARCH_ENGINES.find((e) => e.id === DEFAULT_SEARCH_ENGINE_ID)!
}

export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return (
    typeof value === 'string' &&
    SEARCH_ENGINES.some((e) => e.id === value)
  )
}
