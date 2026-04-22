import { create } from 'zustand'
import type { TLShapeId } from 'tldraw'

// Store DOM-side pour le survol et l'état « active work » des shapes portail
// (Terminal, VSCode, Chat). Nécessaire car `editor.getHoveredShapeId()` de
// tldraw ne se met PAS à jour quand la souris passe au-dessus d'une iframe
// (l'iframe capture tous les pointer events avant que tldraw les voie). On
// délègue donc la détection du hover à des `onMouseEnter/Leave` DOM sur le
// slot externe du portail (ShapePortalManager), qui publient dans ce store.
//
// Deux états distincts :
//
//   - `hoveredShapeId` : dernière shape survolée (MouseEnter sur le slot).
//     Remis à null au MouseLeave. Utilisé pour la bordure de hover fine
//     (blanc 10 %).
//
//   - `activeWorkShapeId` : shape sur laquelle un clic a été fait dans sa
//     zone interactive (iframe VSCode, wrapper xterm, capsule Chat).
//     Représente « l'utilisateur est en train de travailler dedans ».
//     Efface toute bordure visible (immersion totale) — aucun remplaçant
//     visuel. Le retour à l'état sélection/resize se fait lorsque
//     l'utilisateur reclique sur le header de la shape (détecté via un
//     listener global `pointerdown` dans ShapePortalManager qui bounds-
//     check la bande header pour clear l'active work).
//
// Les deux IDs sont mutuellement exclusifs au niveau store : une seule
// shape peut être hoveredShapeId, une seule peut être activeWorkShapeId.
// L'activeWorkShapeId est reset quand tldraw désélectionne la shape
// (logique gérée côté consumer via `useShapeBorderState`).

interface PortalHoverState {
  hoveredShapeId: TLShapeId | null
  activeWorkShapeId: TLShapeId | null
  setHoveredShapeId: (id: TLShapeId | null) => void
  setActiveWorkShapeId: (id: TLShapeId | null) => void
}

export const usePortalHoverStore = create<PortalHoverState>((set) => ({
  hoveredShapeId: null,
  activeWorkShapeId: null,
  setHoveredShapeId: (id) => set({ hoveredShapeId: id }),
  setActiveWorkShapeId: (id) => set({ activeWorkShapeId: id })
}))
