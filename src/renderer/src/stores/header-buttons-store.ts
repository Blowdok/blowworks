import { create } from 'zustand'
import {
  DEFAULT_HEADER_BUTTONS,
  HEADER_BUTTONS_COLLAPSED_KEY,
  HEADER_BUTTONS_SETTINGS_KEY,
  generateHeaderButtonId,
  generateHeaderEntryId,
  insertEntry,
  isDescendantFolder,
  mapEntry,
  parseHeaderButtons,
  removeEntry,
  reorderSibling,
  type HeaderButton,
  type HeaderButtonEntry,
  type HeaderButtonFolder,
  type HeaderButtonItem
} from '@shared/header-buttons.js'

// Store des boutons custom du Header. Persiste dans SQLite settings (clé
// `header.buttons`) via `window.blow.settings`. Hydratation au boot via
// `App.tsx`. Toute mutation déclenche une écriture best-effort (le UI
// n'attend pas la fin de l'I/O — l'utilisateur voit son changement
// instantanément).
//
// Au premier lancement (clé absente) on seed avec `DEFAULT_HEADER_BUTTONS`
// (qui reproduit l'ancien menu IA hardcodé). Si l'utilisateur supprime
// tous les boutons, on N'écrase PAS avec le seed : un tableau vide
// persiste tel quel et le Header n'affiche aucun bouton custom — c'est
// un choix utilisateur valide.
//
// Modèle d'arbre : chaque bouton contient des `entries` qui peuvent être
// soit `{ kind: 'item' }` (URL terminale) soit `{ kind: 'folder' }`
// (conteneur récursif). Profondeur illimitée. Toutes les mutations
// passent par les helpers immuables de `header-buttons.ts` —
// reconstruction immutable de l'arbre à chaque write.

interface HeaderButtonsState {
  hydrated: boolean
  buttons: HeaderButton[]
  // Set d'ids de dossiers actuellement repliés dans l'UI Settings >
  // Navigateur > Boutons du Header. Persisté dans SQLite (clé séparée
  // `header.collapsedFolders`) pour conserver la préférence d'affichage
  // entre les sessions. Set en mémoire pour des lookups O(1) ; sérialisé
  // en `string[]` au moment du write.
  collapsedFolderIds: Set<string>
  toggleFolderCollapsed: (id: string) => void
  isFolderCollapsed: (id: string) => boolean
  hydrate: () => Promise<void>

  // CRUD boutons (racine de l'arborescence)
  addButton: (label: string, color: string) => string
  updateButton: (id: string, patch: Partial<Pick<HeaderButton, 'label' | 'color'>>) => void
  removeButton: (id: string) => void
  moveButton: (id: string, direction: -1 | 1) => void

  // CRUD entries dans un bouton (à n'importe quelle profondeur)
  // `parentFolderId = null` cible la racine du bouton (entries directs).
  addItem: (
    buttonId: string,
    parentFolderId: string | null,
    item: Omit<HeaderButtonItem, 'id' | 'kind'>
  ) => void
  addFolder: (buttonId: string, parentFolderId: string | null, label: string) => void
  updateEntry: (
    buttonId: string,
    entryId: string,
    patch: Partial<Omit<HeaderButtonItem, 'id' | 'kind'>> & { label?: string }
  ) => void
  removeEntry: (buttonId: string, entryId: string) => void
  // Réordonne deux frères au sein du même parent. Pas de cross-parent ici
  // — pour ça on a `moveEntryToFolder`.
  moveEntry: (
    buttonId: string,
    parentFolderId: string | null,
    entryId: string,
    direction: -1 | 1
  ) => void
  // Déplace un entry (item OU dossier) vers un dossier cible (ou racine).
  // Refuse silencieusement si le déplacement créerait un cycle (déplacer
  // un dossier dans un de ses propres descendants).
  moveEntryToFolder: (
    buttonId: string,
    entryId: string,
    targetFolderId: string | null
  ) => void

  // Réinitialise au preset IA. Utile pour un bouton "Restaurer les
  // services par défaut" si l'utilisateur regrette d'avoir tout supprimé.
  resetToDefaults: () => void
}

function persist(buttons: HeaderButton[]): void {
  void window.blow.settings
    .set(HEADER_BUTTONS_SETTINGS_KEY, JSON.stringify(buttons))
    .catch(() => {
      /* best-effort, ne bloque pas l'UI */
    })
}

function persistCollapsed(collapsed: Set<string>): void {
  void window.blow.settings
    .set(HEADER_BUTTONS_COLLAPSED_KEY, JSON.stringify([...collapsed]))
    .catch(() => {
      /* best-effort, ne bloque pas l'UI */
    })
}

// Parse la valeur SQLite des dossiers repliés. Tolère les entrées
// invalides (non-string, JSON cassé, type incorrect) — fallback sur Set
// vide pour ne jamais bloquer l'hydratation.
async function readCollapsedFolderIds(): Promise<Set<string>> {
  try {
    const raw = await window.blow.settings.get(HEADER_BUTTONS_COLLAPSED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

// Clone immuable du seed. Le seed est `readonly` pour empêcher les
// mutations accidentelles à compile-time, mais on a besoin d'un tableau
// mutable pour le state Zustand (`buttons: HeaderButton[]`).
function cloneSeed(): HeaderButton[] {
  return DEFAULT_HEADER_BUTTONS.map((b) => ({
    ...b,
    entries: b.entries.map(cloneEntry)
  }))
}

function cloneEntry(e: HeaderButtonEntry): HeaderButtonEntry {
  if (e.kind === 'item') return { ...e }
  return { ...e, children: e.children.map(cloneEntry) }
}

export const useHeaderButtonsStore = create<HeaderButtonsState>((set, get) => ({
  hydrated: false,
  buttons: [],
  collapsedFolderIds: new Set(),

  toggleFolderCollapsed: (id) => {
    const cur = get().collapsedFolderIds
    const next = new Set(cur)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ collapsedFolderIds: next })
    if (get().hydrated) persistCollapsed(next)
  },

  isFolderCollapsed: (id) => get().collapsedFolderIds.has(id),

  hydrate: async () => {
    try {
      const [raw, collapsedFolderIds] = await Promise.all([
        window.blow.settings.get(HEADER_BUTTONS_SETTINGS_KEY),
        readCollapsedFolderIds()
      ])
      const parsed = parseHeaderButtons(raw)
      if (parsed === null) {
        // Première hydratation OU JSON corrompu → seed avec preset IA et
        // persist immédiatement pour que le seed devienne la source de
        // vérité disque. Permet à l'utilisateur d'éditer dès le 1er boot.
        const seed = cloneSeed()
        set({ buttons: seed, collapsedFolderIds, hydrated: true })
        persist(seed)
      } else {
        set({ buttons: parsed, collapsedFolderIds, hydrated: true })
        // Si parse a retourné un format v1 migré, on persiste la v2 pour
        // que les prochains boots lisent directement le bon format.
        if (raw && parsed.some((b) => b.entries.length > 0)) {
          persist(parsed)
        }
      }
    } catch {
      set({
        buttons: cloneSeed(),
        collapsedFolderIds: new Set(),
        hydrated: true
      })
    }
  },

  addButton: (label, color) => {
    const id = generateHeaderButtonId()
    const next: HeaderButton = { id, label, color, entries: [] }
    const buttons = [...get().buttons, next]
    set({ buttons })
    if (get().hydrated) persist(buttons)
    return id
  },

  updateButton: (id, patch) => {
    const buttons = get().buttons.map((b) => (b.id === id ? { ...b, ...patch } : b))
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  removeButton: (id) => {
    const buttons = get().buttons.filter((b) => b.id !== id)
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  moveButton: (id, direction) => {
    const arr = [...get().buttons]
    const idx = arr.findIndex((b) => b.id === id)
    if (idx === -1) return
    const target = idx + direction
    if (target < 0 || target >= arr.length) return
    const [item] = arr.splice(idx, 1)
    arr.splice(target, 0, item)
    set({ buttons: arr })
    if (get().hydrated) persist(arr)
  },

  addItem: (buttonId, parentFolderId, item) => {
    const newEntry: HeaderButtonItem = {
      kind: 'item',
      id: generateHeaderEntryId(),
      label: item.label,
      url: item.url,
      tagline: item.tagline
    }
    const buttons = get().buttons.map((b) =>
      b.id === buttonId
        ? { ...b, entries: insertEntry(b.entries, parentFolderId, newEntry) }
        : b
    )
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  addFolder: (buttonId, parentFolderId, label) => {
    const newEntry: HeaderButtonFolder = {
      kind: 'folder',
      id: generateHeaderEntryId(),
      label,
      children: []
    }
    const buttons = get().buttons.map((b) =>
      b.id === buttonId
        ? { ...b, entries: insertEntry(b.entries, parentFolderId, newEntry) }
        : b
    )
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  updateEntry: (buttonId, entryId, patch) => {
    const buttons = get().buttons.map((b) => {
      if (b.id !== buttonId) return b
      return {
        ...b,
        entries: mapEntry(b.entries, entryId, (e) => {
          if (e.kind === 'item') {
            return {
              ...e,
              label: patch.label ?? e.label,
              url: patch.url ?? e.url,
              tagline: patch.tagline === undefined ? e.tagline : patch.tagline
            }
          }
          // Folder : seul le label est éditable.
          return { ...e, label: patch.label ?? e.label }
        })
      }
    })
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  removeEntry: (buttonId, entryId) => {
    const buttons = get().buttons.map((b) => {
      if (b.id !== buttonId) return b
      return { ...b, entries: removeEntry(b.entries, entryId).tree }
    })
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  moveEntry: (buttonId, parentFolderId, entryId, direction) => {
    const buttons = get().buttons.map((b) => {
      if (b.id !== buttonId) return b
      return {
        ...b,
        entries: reorderSibling(b.entries, parentFolderId, entryId, direction)
      }
    })
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  moveEntryToFolder: (buttonId, entryId, targetFolderId) => {
    const buttons = get().buttons.map((b) => {
      if (b.id !== buttonId) return b
      // Garde-fou anti-cycle : on ne déplace pas un dossier dans un de
      // ses propres descendants (créerait un graphe cyclique).
      if (
        targetFolderId !== null &&
        isDescendantFolder(b.entries, entryId, targetFolderId)
      ) {
        return b
      }
      const { tree, removed } = removeEntry(b.entries, entryId)
      if (!removed) return b
      return { ...b, entries: insertEntry(tree, targetFolderId, removed) }
    })
    set({ buttons })
    if (get().hydrated) persist(buttons)
  },

  resetToDefaults: () => {
    const seed = cloneSeed()
    set({ buttons: seed })
    if (get().hydrated) persist(seed)
  }
}))
