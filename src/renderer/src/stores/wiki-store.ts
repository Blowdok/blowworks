import { create } from 'zustand'
import type { WikiFolderStatusT, AgentWikiBuilderResultT } from '@shared/ipc-contract.js'

// Store Zustand pour le statut du dossier wiki (mémoire long-terme).
//
// Deux rôles :
//   1. Statut wiki (folderPath, initialized, rawCount, wikiCount) partagé
//      entre ChatPortalView, MemorySidebarSection, WikiSettingsTab et
//      WikiSidebarSection — évite que chaque composant garde un state
//      local qui dérive quand l'utilisateur configure le wiki ailleurs.
//   2. État d'exécution `building` du Wiki Builder partagé : n'importe
//      où on clique « Reconstruire », les deux boutons (sidebar +
//      settings) passent en « en cours » et ne peuvent pas lancer une
//      seconde exécution en parallèle.
//
// Le chemin vers le viewer markdown (openPageName) permet aussi aux
// liens markdown dans le chat de pointer vers une page précise :
// n'importe quel composant set openPageName → WikiPageViewer (mount
// dans la sidebar) ouvre la modale.

const EMPTY_STATUS: WikiFolderStatusT = {
  folderPath: null,
  initialized: false,
  rawCount: 0,
  wikiCount: 0
}

interface WikiStore {
  status: WikiFolderStatusT
  loading: boolean

  // Exécution Wiki Builder — partagée entre sidebar et settings pour
  // qu'un seul bouton soit actif à la fois et que le feedback soit
  // cohérent partout.
  building: boolean
  buildFeedback:
    | { kind: 'ok'; message: string }
    | { kind: 'error'; message: string }
    | null

  // Page wiki à afficher dans le viewer modal. Null = aucun viewer
  // ouvert. Toute chaîne = ouvre la modale sur cette page (chemin
  // relatif à wiki/, ex: "concepts/pagemark.md").
  openPageName: string | null

  // Fichier arbitraire à afficher dans le viewer (chemin relatif au
  // dossier wiki, ex: "SCHEMA.md", "raw/foo.md", "audit/lint.md").
  // Utilisé par l'explorateur pour ouvrir les fichiers HORS `wiki/`
  // dans le même viewer markdown intégré — évite que l'OS lance
  // VSCode/Notepad à chaque clic. Mutuellement exclusif avec
  // `openPageName` : ouvrir l'un clear l'autre.
  openFilePath: string | null

  // Mode d'affichage de la sidebar : standard (projets + mémoire + graph)
  // ou explorateur wiki plein cadre. Contrôle lancé par un bouton dans
  // la section Mémoire.
  sidebarMode: 'standard' | 'wiki-explorer'

  // Ouvre/ferme la modale de visualisation du graphe wiki.
  graphOpen: boolean

  // Largeur (0..1) du panneau gauche actuellement ouvert (viewer ou
  // graph). `null` = aucun panneau ouvert. Mis à jour en continu par
  // viewer/graph pendant le resize ; consommé par ShapeAutoStacker
  // pour calculer la zone libre droite et y empiler les shapes du
  // canvas. Centralisé ici pour que viewer/graph et le stacker se
  // synchronisent sans connaître les internes l'un de l'autre.
  leftPanelWidthFraction: number | null

  refresh: () => Promise<void>
  setStatus: (s: WikiFolderStatusT) => void

  runWikiBuilder: () => Promise<void>
  dismissBuildFeedback: () => void

  openWikiPage: (name: string) => void
  closeWikiPage: () => void

  openWikiFile: (relPath: string) => void

  setSidebarMode: (m: 'standard' | 'wiki-explorer') => void
  setGraphOpen: (v: boolean) => void
  setLeftPanelWidthFraction: (f: number | null) => void
}

export const useWikiStore = create<WikiStore>((set, get) => ({
  status: EMPTY_STATUS,
  loading: false,
  building: false,
  buildFeedback: null,
  openPageName: null,
  openFilePath: null,
  sidebarMode: 'standard',
  graphOpen: false,
  leftPanelWidthFraction: null,

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

  setStatus: (s) => set({ status: s }),

  runWikiBuilder: async () => {
    // Re-entrancy guard : si un build est déjà en cours, on ne relance pas.
    if (get().building) return
    set({ building: true, buildFeedback: null })
    try {
      const r = (await window.blow.agents.runWikiBuilder()) as AgentWikiBuilderResultT
      const n = r.operations.length
      set({
        building: false,
        buildFeedback: {
          kind: 'ok',
          message: `${n} page${n > 1 ? 's' : ''} mise${n > 1 ? 's' : ''} à jour`
        }
      })
      await get().refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ building: false, buildFeedback: { kind: 'error', message: msg } })
    }
  },

  dismissBuildFeedback: () => set({ buildFeedback: null }),

  openWikiPage: (name) => set({ openPageName: name, openFilePath: null }),
  closeWikiPage: () => set({ openPageName: null, openFilePath: null }),

  openWikiFile: (relPath) => set({ openFilePath: relPath, openPageName: null }),

  setSidebarMode: (m) => set({ sidebarMode: m }),
  setGraphOpen: (v) => set({ graphOpen: v }),
  setLeftPanelWidthFraction: (f) => set({ leftPanelWidthFraction: f })
}))
