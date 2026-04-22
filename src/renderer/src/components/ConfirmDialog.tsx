import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Modale de confirmation générique, réutilisable pour toute action
// destructive (suppression d'un projet, d'une iframe, etc.).
//
// - RENDU VIA `createPortal(document.body)` : indispensable car les
//   modales appelées depuis une shape portail (VSCodeShape / TerminalShape)
//   étaient rendues dans le slot du `ShapePortalManager`, lequel vit dans
//   un clip container `pointer-events: none` + `overflow: hidden` + un
//   slot avec `transform-origin`. Résultats de cette imbrication : les
//   clics sur "Annuler"/"Supprimer" étaient avalés par l'héritage
//   `pointer-events: none`, et le `position: fixed` utilisait le slot
//   comme containing block (transform parent) au lieu du viewport.
//   Le portail vers `document.body` sort la modale de tout ça.
// - Overlay noir semi-transparent qui bloque les interactions derrière.
// - Échap ferme la modale (équivalent Annuler).
// - Bouton "Supprimer" en rouge sobre (palette monochrome + accent),
//   "Annuler" en secondaire. Focus auto sur Annuler pour éviter la
//   suppression accidentelle à l'Entrée.

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Supprimer',
  cancelLabel = 'Annuler',
  destructive = true,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.ReactElement | null {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)

  // Focus initial sur Annuler (évite un Enter qui confirme par erreur).
  // Échap ferme. Empêche le scroll du body tant que la modale est ouverte.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    cancelBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus()
    }
  }, [open, onCancel])

  if (!open) return null

  const confirmColor = destructive
    ? { color: '#f87171', borderColor: '#f87171' }
    : { color: 'var(--fg-primary)', borderColor: 'var(--fg-secondary)' }

  // Rendu via portail dans `document.body` pour échapper à l'héritage
  // `pointer-events: none` du clip container des portails de shapes, et
  // pour que `position: fixed` utilise bien le viewport comme containing
  // block (sinon un ancêtre avec `transform` devient le containing block).
  return createPortal(
    <div
      // z-index > tout (clip container portails = 40, slots = variable).
      // 9999 garantit que la modale couvre même les iframes au premier plan.
      // `pointer-events: auto` explicite : ceinture-bretelles si un style
      // global venait à poser `pointer-events: none` sur `body`.
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ pointerEvents: 'auto' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
        aria-hidden
      />
      <div
        className="relative flex min-w-[320px] max-w-[480px] flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 text-[var(--fg-primary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-dialog-title"
          className="text-sm font-semibold tracking-wide text-[var(--fg-primary)]"
        >
          {title}
        </h2>
        <div className="text-[13px] leading-relaxed text-[var(--fg-secondary)]">
          {message}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs text-[var(--fg-secondary)] transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={confirmColor}
            className="rounded-[var(--radius-sm)] border bg-transparent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
