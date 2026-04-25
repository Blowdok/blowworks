import { useState } from 'react'
import { useUIStore } from '../../stores/ui-store.js'
import { useEditorStore } from '../../stores/editor-store.js'

// Onglet Settings > Canvas : configuration du fond d'écran centré sur
// l'origine (0, 0) du repère tldraw — sert de repère spatial pour
// retrouver "la maison" sur le canvas infini. Bouton recentrer caméra
// pour revenir au point (0,0) zoom 1 d'un clic.

export default function CanvasSettingsTab(): React.ReactElement {
  const dataUrl = useUIStore((s) => s.canvasBgDataUrl)
  const opacity = useUIStore((s) => s.canvasBgOpacity)
  const size = useUIStore((s) => s.canvasBgSize)
  const setDataUrl = useUIStore((s) => s.setCanvasBgDataUrl)
  const setOpacity = useUIStore((s) => s.setCanvasBgOpacity)
  const setSize = useUIStore((s) => s.setCanvasBgSize)
  const editor = useEditorStore((s) => s.editor)

  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [imageName, setImageName] = useState<string | null>(null)

  async function pickImage(): Promise<void> {
    setError(null)
    setPicking(true)
    try {
      const result = await window.blow.dialog.pickImage({
        title: "Choisir l'image de fond du canvas"
      })
      if (!result) return
      setDataUrl(result.dataUrl)
      setImageName(result.name)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setPicking(false)
    }
  }

  function clearImage(): void {
    setDataUrl(null)
    setImageName(null)
    setError(null)
  }

  function recenterCamera(): void {
    if (!editor) return
    // En tldraw, `setCamera({x, y, z})` positionne l'origine document à
    // (x, y) en coordonnées caméra. Pour CENTRER l'origine (0, 0) au
    // milieu de l'écran, on décale de la moitié de la taille du viewport.
    // Animation fluide pour donner un contexte de mouvement plutôt qu'un
    // teleport sec.
    const vb = editor.getViewportScreenBounds()
    editor.setCamera(
      { x: vb.w / 2, y: vb.h / 2, z: 1 },
      { animation: { duration: 320 } }
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">Canvas</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Image de fond placée à l&apos;origine (0, 0) du canvas infini.
          Elle suit la caméra (zoom et pan), ce qui en fait un repère
          spatial pour retrouver le centre quand tu te promènes sur ton canvas.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <label className="text-[12px] text-[var(--fg-secondary)]">Image</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void pickImage()}
            disabled={picking}
            className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
          >
            {picking ? '…' : dataUrl ? "Changer d'image" : 'Choisir une image…'}
          </button>
          {dataUrl && (
            <button
              type="button"
              onClick={clearImage}
              className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              style={{ borderColor: 'var(--border)' }}
            >
              Supprimer
            </button>
          )}
        </div>
        {imageName && (
          <span className="text-[11px] text-[var(--fg-muted)]">
            Source : <code>{imageName}</code>
          </span>
        )}
        {error && (
          <span className="text-[11px]" style={{ color: '#f87171' }}>
            {error}
          </span>
        )}

        {dataUrl && (
          <div
            className="mt-1 flex items-center justify-center rounded-[var(--radius-sm)] border p-2"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}
          >
            <img
              src={dataUrl}
              alt="Aperçu"
              className="max-h-32 max-w-full"
              style={{ opacity, objectFit: 'contain' }}
              draggable={false}
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <label className="flex items-center justify-between text-[12px] text-[var(--fg-secondary)]">
          <span>Opacité</span>
          <span className="font-mono text-[11px] text-[var(--fg-primary)]">
            {Math.round(opacity * 100)}%
          </span>
        </label>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
        />
      </section>

      <section className="flex flex-col gap-2">
        <label className="flex items-center justify-between text-[12px] text-[var(--fg-secondary)]">
          <span>Taille (px, côté carré)</span>
          <span className="font-mono text-[11px] text-[var(--fg-primary)]">{size}</span>
        </label>
        <input
          type="range"
          min={200}
          max={2400}
          step={50}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
        />
      </section>

      <section className="flex flex-col gap-2 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
        <h4 className="text-[12px] font-medium text-[var(--fg-secondary)]">Navigation</h4>
        <button
          type="button"
          onClick={recenterCamera}
          disabled={!editor}
          className="self-start rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
          style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          title="Revient au point (0,0) zoom 1"
        >
          ⊕ Recentrer la caméra
        </button>
        <p className="text-[10px] text-[var(--fg-muted)]">
          Ramène la caméra au centre du canvas (origine, zoom 100 %).
        </p>
      </section>
    </div>
  )
}
