import { useEffect } from 'react'
import { useUIStore } from '../../stores/ui-store.js'

// Fond de canvas centré à l'origine (0, 0) du repère tldraw. Rendu via
// le slot `components.OnTheCanvas` de tldraw : le wrapper que tldraw
// fournit est DÉJÀ transformé par la matrice de la caméra (zoom + pan),
// donc l'image se comporte comme si elle vivait dans la scène — elle
// sert de repère spatial pour retrouver le centre du canvas infini.
//
// Si l'utilisateur n'a pas configuré d'image, on affiche une croix +
// anneau en pointillé pour matérialiser quand même le centre.

export default function CanvasBackground(): React.ReactElement {
  const dataUrl = useUIStore((s) => s.canvasBgDataUrl)
  const opacity = useUIStore((s) => s.canvasBgOpacity)
  const size = useUIStore((s) => s.canvasBgSize)
  const hydrated = useUIStore((s) => s.hydrated)

  // Log unique au mount pour vérifier que le slot est bien instancié.
  // Si tu ne vois pas ce log dans la console DevTools (Ctrl+Shift+I),
  // c'est que `components.OnTheCanvas` n'est pas branché correctement.
  useEffect(() => {
    console.log('[canvas-bg] OnTheCanvas monté', { hydrated, hasImage: !!dataUrl, opacity, size })
  }, [hydrated, dataUrl, opacity, size])

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

  // Fallback : marqueur de centre. Volontairement bien visible pour que
  // l'utilisateur LE TROUVE quand il configure pour la 1re fois (avant ça
  // il n'a aucun repère pour savoir où est le centre dans son canvas
  // infini, donc le réticule doit attirer l'œil quand on revient sur (0,0)).
  // L'opacité reste modérée pour ne pas distraire.
  const r = 200
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
        opacity: 0.45,
        color: 'var(--fg-secondary, #e5e5e5)'
      }}
      aria-hidden
    >
      <circle cx={0} cy={0} r={r - 8} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="8 8" />
      <circle cx={0} cy={0} r={28} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <line x1={-40} y1={0} x2={40} y2={0} stroke="currentColor" strokeWidth={1.5} />
      <line x1={0} y1={-40} x2={0} y2={40} stroke="currentColor" strokeWidth={1.5} />
      <text
        x={0}
        y={r - 28}
        textAnchor="middle"
        fontSize={14}
        fontFamily="monospace"
        fill="currentColor"
      >
        centre du canvas (0, 0)
      </text>
    </svg>
  )
}
