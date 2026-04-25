import { useUIStore } from '../../stores/ui-store.js'

// Fond de canvas centré à l'origine (0, 0) du repère tldraw. Rendu via
// le slot `components.OnTheCanvas` de tldraw : le wrapper que tldraw
// fournit est DÉJÀ transformé par la matrice de la caméra (zoom + pan),
// donc l'image se comporte comme si elle vivait dans la scène — elle
// sert de repère spatial pour retrouver le centre du canvas infini.
//
// Si l'utilisateur n'a pas configuré d'image, on affiche un cercle en
// pointillé léger pour matérialiser quand même le centre.

export default function CanvasBackground(): React.ReactElement {
  const dataUrl = useUIStore((s) => s.canvasBgDataUrl)
  const opacity = useUIStore((s) => s.canvasBgOpacity)
  const size = useUIStore((s) => s.canvasBgSize)

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt=""
        // pointer-events: none pour ne JAMAIS intercepter les clics —
        // c'est un visuel de repère, pas un élément interactif.
        // user-select: none pour ne pas être attrapé dans une sélection
        // de texte sur la page.
        style={{
          position: 'absolute',
          left: -size / 2,
          top: -size / 2,
          width: size,
          height: size,
          opacity,
          pointerEvents: 'none',
          userSelect: 'none',
          objectFit: 'contain'
        }}
        draggable={false}
      />
    )
  }

  // Fallback : marqueur de centre minimaliste (anneau pointillé +
  // réticule fin). Utile au tout 1er boot avant que l'utilisateur
  // n'ait configuré son image.
  const r = 60
  return (
    <svg
      width={2 * r}
      height={2 * r}
      viewBox={`-${r} -${r} ${2 * r} ${2 * r}`}
      style={{
        position: 'absolute',
        left: -r,
        top: -r,
        pointerEvents: 'none',
        opacity: 0.18
      }}
      aria-hidden
    >
      <circle cx={0} cy={0} r={r - 4} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="4 4" />
      <line x1={-12} y1={0} x2={12} y2={0} stroke="currentColor" strokeWidth={1} />
      <line x1={0} y1={-12} x2={0} y2={12} stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}
