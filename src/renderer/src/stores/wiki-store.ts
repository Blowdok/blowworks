import { create } from 'zustand'
import type { WikiFolderStatusT } from '@shared/ipc-contract.js'

// Store Zustand pour le statut du dossier wiki (mémoire long-terme).
//
// Problème sans ce store : chaque composant qui dépend de l'état
// "wiki configuré ?" (ChatPortalView, MemorySidebarSection, WikiSettingsTab,
// GraphSidebarSection demain) appelait `window.blow.wiki.getFolder()` au
// mount et gardait son résultat en state local. Si l'utilisateur
// configure le dossier APRÈS avoir ouvert une ChatShape, la shape voyait
// toujours `initialized: false` et le bouton ✦ Synthétiser restait grisé
// jusqu'à un refresh complet.
//
// Solution : un point unique de vérité côté renderer, refreshé après
// chaque mutation (chooseFolder notamment). Tous les consommateurs
// souscrivent et rerender automatiquement.

const EMPTY_STATUS: WikiFolderStatusT = {
  folderPath: null,
  initialized: false,
  rawCount: 0,
  wikiCount: 0
}

interface WikiStore {
  status: WikiFolderStatusT
  loading: boolean

  // Refetch le statut depuis le main. Appelé au boot + après chaque
  // mutation (choose, reconstruire, synthétiser).
  refresh: () => Promise<void>

  // Setter direct utilisé par les handlers qui reçoivent déjà le
  // statut à jour dans leur réponse (chooseFolder retourne le statut
  // final). Évite un refetch inutile.
  setStatus: (s: WikiFolderStatusT) => void
}

export const useWikiStore = create<WikiStore>((set) => ({
  status: EMPTY_STATUS,
  loading: false,

  refresh: async () => {
    set({ loading: true })
    try {
      const s = (await window.blow.wiki.getFolder()) as WikiFolderStatusT
      set({ status: s, loading: false })
    } catch (e) {
      console.warn('[wiki-store] refresh failed', e)
      set({ loading: false })
    }
  },

  setStatus: (s) => set({ status: s })
}))
