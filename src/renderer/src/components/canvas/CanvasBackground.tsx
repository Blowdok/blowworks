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

  // IMPORTANT — pattern de positionnement : le parent `.tl-html-layer.tl-shapes`
  // a `contain: layout style size` + `width/height: 1px`. Les vraies shapes
  // tldraw (`.tl-shape`) utilisent `position: absolute + transform-origin: top left
  // + transform: translate(x, y)` plutôt que `top/left`. On suit exactement ce
  // pattern : positionner via `transform` garantit que la coordonnée document
  // (0,0) corresponde bien à la position visible du fond, malgré le containment
  // CSS du parent.
  const commonWrapperStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    transformOrigin: 'top left',
    pointerEvents: 'none',
    userSelect: 'none'
  }

  if (dataUrl) {
    return (
      <div
        style={{
          ...commonWrapperStyle,
          transform: `translate(${-size / 2}px, ${-size / 2}px)`,
          width: size,
          height: size,
          opacity
        }}
      >
        <img
          src={dataUrl}
          alt=""
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
            userSelect: 'none'
          }}
        />
      </div>
    )
  }

  // Fallback : marqueur de centre. Volontairement bien visible pour que
  // l'utilisateur LE TROUVE quand il recentre la caméra et n'a pas encore
  // configuré son image custom.
  const r = 200
  return (
    <div
      style={{
        ...commonWrapperStyle,
        transform: `translate(${-r}px, ${-r}px)`,
        width: 2 * r,
        height: 2 * r,
        opacity: 0.5,
        color: 'var(--fg-secondary, #e5e5e5)'
      }}
    >
      <svg
        width={2 * r}
        height={2 * r}
        viewBox={`-${r} -${r} ${2 * r} ${2 * r}`}
        aria-hidden
        style={{ display: 'block' }}
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
    </div>
  )
}
