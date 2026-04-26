import { useEffect } from 'react'
import Header from './components/Header.js'
import Sidebar from './components/Sidebar.js'
import TabsBar from './components/TabsBar.js'
import InfiniteCanvas from './components/canvas/InfiniteCanvas.js'
import DeleteInterceptor from './components/DeleteInterceptor.js'
import ShapeAutoStacker from './components/ShapeAutoStacker.js'
import { useProjectStore } from './stores/project-store.js'
import { useUIStore } from './stores/ui-store.js'
import { useChatStore } from './stores/chat-store.js'
import { useWikiStore } from './stores/wiki-store.js'
import { useBrowserStore } from './stores/browser-store.js'

// Layout BlowWorks :
// ┌──────────────────────── Header (48px) ────────────────────────┐
// ├─────────────────────── TabsBar (36px) ────────────────────────┤
// ├────────────┬──────────────────────────────────────────────────┤
// │  Sidebar   │              Workspace (canvas infini)           │
// │ (64↔240px) │                                                  │
// └────────────┴──────────────────────────────────────────────────┘
export default function App() {
  const loadProjects = useProjectStore((s) => s.load)
  const hydrateUI = useUIStore((s) => s.hydrate)
  const hydrateChat = useChatStore((s) => s.hydrate)
  const refreshWiki = useWikiStore((s) => s.refresh)
  const hydrateBrowser = useBrowserStore((s) => s.hydrate)

  useEffect(() => {
    loadProjects()
    void hydrateUI()
    // Hydrate l'état IA : statut clés API, défauts, liste modèles (si clé
    // OpenRouter présente) + installation du listener global `ai.onChunk`
    // pour router les deltas de streaming vers `activeStreams[convId]`.
    void hydrateChat()
    // Charge le statut du dossier wiki : gouverne les boutons ✦ (chat),
    // 📚 (chat) et la section Mémoire de la sidebar. Réagit aux mutations
    // via `useWikiStore.setStatus` côté chooseFolder/reconstruire.
    void refreshWiki()
    // Charge la liste des favoris du navigateur intégré + souscrit au
    // push event `bookmarks.onChanged` pour rester synchro entre les
    // BrowserShapes (étoile remplie/vide).
    void hydrateBrowser()
  }, [loadProjects, hydrateUI, hydrateChat, refreshWiki, hydrateBrowser])

  return (
    <div className="grid h-full w-full grid-rows-[48px_1fr] bg-[var(--bg-primary)]">
      <Header />
      <div className="grid h-full min-h-0 grid-cols-[auto_1fr]">
        <Sidebar />
        <div className="grid h-full min-h-0 grid-rows-[36px_1fr]">
          <TabsBar />
          <main className="relative h-full min-h-0 w-full min-w-0 overflow-hidden">
            <InfiniteCanvas />
            {/* Point de montage des panneaux d'overlay (viewer markdown,
                graph) — target de createPortal. Positionné en absolute
                inset-0 mais pointer-events: none au wrapper pour que
                tldraw reste cliquable en dessous tant qu'aucun panneau
                n'est ouvert. Les enfants activent pointer-events: auto
                sur leur propre contenu. z-[30] = au-dessus des shapes
                mais en dessous du DeleteInterceptor (z > 9000). */}
            <div
              id="canvas-overlay-root"
              className="pointer-events-none absolute inset-0 z-[30]"
            />
          </main>
        </div>
      </div>
      {/* Intercepte les suppressions de shapes portail (VSCode / Terminal)
          depuis n'importe quel déclencheur tldraw (touche Delete, menu
          contextuel, barre d'actions) pour afficher la modale de
          confirmation. Doit vivre au niveau App pour survivre à tout
          changement de layout ou de page tldraw. */}
      <DeleteInterceptor />
      {/* Auto-stack des shapes utilisateur en colonne à droite quand un
          panneau gauche (viewer markdown ou graph) est ouvert. Restaure
          les positions à la fermeture. Cohabite avec n'importe quel
          panneau via `wikiStore.leftPanelWidthFraction`. */}
      <ShapeAutoStacker />
    </div>
  )
}
