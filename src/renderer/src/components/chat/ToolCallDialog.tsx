import { createPortal } from 'react-dom'

// Dialog de confirmation d'un tool destructif. Affiché quand
// `activeStreams[convId].awaitingConfirm` devient non-null (le main
// attend la décision utilisateur pour débloquer la boucle agent).
//
// UX : inline modal par-dessus le canvas, pas d'échappement clavier par
// erreur — il faut cliquer explicitement Approuver ou Refuser. Timeout
// serveur côté main = 5 min (géré là-bas, pas ici).

interface ToolCallDialogProps {
  open: boolean
  toolName: string
  args: Record<string, unknown>
  onApprove: () => void
  onReject: () => void
}

export default function ToolCallDialog({
  open,
  toolName,
  args,
  onApprove,
  onReject
}: ToolCallDialogProps): React.ReactElement | null {
  if (!open) return null

  const preview = buildArgsPreview(toolName, args)

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      role="alertdialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/70" />
      <div
        className="relative m-auto flex w-[min(540px,90vw)] flex-col gap-3 rounded-[var(--radius-md)] border p-5 text-[var(--fg-primary)] shadow-2xl"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: '#f59e0b'
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="text-[18px]">⚠️</span>
          <h2 className="text-[13px] font-semibold uppercase tracking-widest" style={{ color: '#f59e0b' }}>
            Action IA destructive
          </h2>
        </div>

        <div className="text-[12px] text-[var(--fg-muted)]">
          L&apos;agent veut exécuter le tool <code>{toolName}</code> sur le wiki. Vérifie et approuve.
        </div>

        <div
          className="max-h-[280px] overflow-auto rounded border bg-[var(--bg-tertiary)] p-3 text-[12px]"
          style={{ borderColor: 'var(--border)' }}
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--fg-primary)]">
            {preview}
          </pre>
        </div>

        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onReject}
            className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px] hover:bg-[var(--bg-tertiary)]"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
          >
            Refuser
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px] font-medium"
            style={{ borderColor: '#f59e0b', color: '#f59e0b' }}
          >
            Approuver
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Prévisualise les arguments du tool de façon lisible. Pour write_wiki_page,
// coupe le contenu markdown à ~400 caractères pour ne pas saturer le dialog.
function buildArgsPreview(name: string, args: Record<string, unknown>): string {
  if (name === 'write_wiki_page') {
    const n = typeof args.name === 'string' ? args.name : '(nom manquant)'
    const c = typeof args.content === 'string' ? args.content : ''
    const truncated =
      c.length > 400 ? c.slice(0, 400) + `\n\n…[${c.length - 400} caractères tronqués]` : c
    return `name: ${n}\n\ncontent:\n${truncated}`
  }
  if (name === 'rename_wiki_page') {
    const from = typeof args.from === 'string' ? args.from : '?'
    const to = typeof args.to === 'string' ? args.to : '?'
    return `from: ${from}\nto:   ${to}`
  }
  if (name === 'delete_wiki_page') {
    const n = typeof args.name === 'string' ? args.name : '(nom manquant)'
    return `name: ${n}`
  }
  // Fallback : JSON formaté.
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}
