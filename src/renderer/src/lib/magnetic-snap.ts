// Snap magnétique pour les drag-resize de panels (viewer markdown, graph
// wiki). Comportement :
//   - L'utilisateur peut redimensionner librement (pas de cap dur).
//   - Quand la fraction approche le centre (0.5 par défaut), le panel
//     "colle" à 50% — il faut tirer plus fort pour décoller.
//   - Hystérésis : zone d'entrée serrée (SNAP_ENTER), zone de sortie
//     plus large (SNAP_EXIT) → évite l'oscillation à la frontière.
//
// Utilisé conjointement avec un état booléen `snapped` côté composant
// pour afficher un feedback visuel (handle plus visible quand on est
// aimanté).

export interface MagneticSnapResult {
  frac: number
  snapped: boolean
}

const SNAP_ENTER = 0.025 // ±2.5% pour entrer dans la zone aimantée
const SNAP_EXIT = 0.06 // ±6% pour s'en échapper (hystérésis)

export function applyMagneticSnap(
  rawFrac: number,
  currentlySnapped: boolean,
  target = 0.5
): MagneticSnapResult {
  const dist = Math.abs(rawFrac - target)
  if (currentlySnapped) {
    // Reste snappé tant qu'on ne sort pas de la zone élargie.
    if (dist > SNAP_EXIT) return { frac: rawFrac, snapped: false }
    return { frac: target, snapped: true }
  }
  // Pas snappé : on se "colle" au centre dès qu'on entre dans la zone serrée.
  if (dist <= SNAP_ENTER) return { frac: target, snapped: true }
  return { frac: rawFrac, snapped: false }
}
