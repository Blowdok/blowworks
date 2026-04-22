import { type TLShapeId } from 'tldraw'
import { usePortalHoverStore } from '../stores/portal-hover-store.js'

// État visuel de bordure d'une shape portail (Terminal, VSCode, Chat).
// Le chrome de sélection/resize est entièrement géré par tldraw NATIVEMENT
// (bordure bleue + handles dessinés dans son overlay SVG) — on ne superpose
// plus de bordure cyan custom, qui créait un effet de « double bordure »
// inutile. Ce hook ne pilote plus que :
//
//   - La bordure de HOVER (fine, blanche) quand la souris survole la shape
//     sans avoir cliqué dedans. Détectée via `portal-hover-store` alimenté
//     par `onMouseEnter/Leave` sur le slot portail — fonctionne au-dessus
//     des iframes (contrairement à `editor.getHoveredShapeId()`).
//
//   - L'état « active work » : l'utilisateur a cliqué dans la zone
//     interactive de la shape (iframe / xterm / capsule Chat), il veut
//     travailler dedans sans chrome. Côté `ShapePortalManager`, on
//     désélectionne aussi la shape dans tldraw → la bordure bleue native
//     et les handles disparaissent. Côté hook, on masque aussi la bordure
//     de hover (puisqu'on survole forcément une shape en active work).
//
//   - La couleur de projet assigné : signal prioritaire, toujours visible
//     (bordure colorée du projet + halo). Permet de savoir à quel projet
//     appartient chaque shape, même en pleine immersion.

export interface ShapeBorderState {
  isHovered: boolean
  isActiveWork: boolean
}

export function useShapeBorderState(shapeId: TLShapeId): ShapeBorderState {
  const hoveredShapeId = usePortalHoverStore((s) => s.hoveredShapeId)
  const activeWorkShapeId = usePortalHoverStore((s) => s.activeWorkShapeId)
  return {
    isHovered: hoveredShapeId === shapeId,
    isActiveWork: activeWorkShapeId === shapeId
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers de composition du style de bordure.
// ─────────────────────────────────────────────────────────────────────

export interface ShapeBorderStyle {
  border: string
  boxShadow: string | undefined
  transition: string
}

const BORDER_TRANSITION = 'border-color 240ms ease-out, box-shadow 240ms ease-out'

// Palette — 3 niveaux seulement (tldraw gère la sélection/resize native) :
//   - Projet assigné : bordure colorée 1 px nette, SANS halo externe (le
//     halo `0 0 0 2 px …22` brouillait le contour sur fond sombre).
//   - Hover : bordure blanche très fine (10 % opacity).
//   - Idle / Active work : invisible (fusion canvas).
const BORDER_HOVER = 'rgba(255, 255, 255, 0.10)'
const BORDER_IDLE = 'var(--shape-surface, #101011)'

/**
 * Compose le style CSS (border + shadow + transition) à appliquer sur le
 * wrapper externe d'une shape portail. Priorité :
 *
 *   1. Projet assigné (signal fort permanent).
 *   2. Active work (immersion totale — aucun chrome ajouté, tldraw est
 *      déjà désélectionné côté gestionnaire).
 *   3. Hover (sans clic) — bordure blanche fine pour signaler la présence.
 *   4. Repos — fusion canvas.
 */
export function getShapeBorderStyle(
  state: ShapeBorderState,
  assignedProjectColor: string | null
): ShapeBorderStyle {
  if (assignedProjectColor !== null) {
    return {
      border: `0.5px solid ${assignedProjectColor}`,
      boxShadow: undefined,
      transition: BORDER_TRANSITION
    }
  }

  // Active work → immersion : pas de bordure de hover non plus.
  if (state.isActiveWork) {
    return {
      border: `0.5px solid ${BORDER_IDLE}`,
      boxShadow: undefined,
      transition: BORDER_TRANSITION
    }
  }

  if (state.isHovered) {
    return {
      border: `0.5px solid ${BORDER_HOVER}`,
      boxShadow: undefined,
      transition: BORDER_TRANSITION
    }
  }

  return {
    border: `0.5px solid ${BORDER_IDLE}`,
    boxShadow: undefined,
    transition: BORDER_TRANSITION
  }
}
