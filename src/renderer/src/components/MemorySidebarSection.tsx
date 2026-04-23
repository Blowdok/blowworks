import { useEffect, useState } from 'react'
import type {
  WikiFolderStatusT,
  AgentWikiBuilderResultT
} from '@shared/ipc-contract.js'

// Section « Mémoire » de la Sidebar de l'app — permet de reconstruire le
// wiki (agent Wiki Builder) sans quitter la page courante. Le bouton
// « Synthétiser une conversation » reste dans le header de chaque
// ChatShape car il cible une conversation précise.
//
// Deux états :
//   - wiki non configuré → bouton « Configurer » qui ouvre Settings > Wiki
//   - wiki configuré → stats raw/wiki + bouton « ✦ Reconstruire »

interface MemorySidebarSectionProps {
  collapsed: boolean
  onOpenWikiSettings: () => void
}

export default function MemorySidebarSection({
  collapsed,
  onOpenWikiSettings
}: MemorySidebarSectionProps): React.ReactElement {
  const [status, setStatus] = useState<WikiFolderStatusT | null>(null)
  const [building, setBuilding] = useState(false)
  const [feedback, setFeedback] = useState<
    { kind: 'ok'; message: string } | { kind: 'error'; message: string } | null
  >(null)

  async function refresh(): Promise<void> {
    try {
      const s = (await window.blow.wiki.getFolder()) as WikiFolderStatusT
      setStatus(s)
    } catch {
      setStatus(null)
    }
  }

  // Charge le statut au mount. `cancelled` évite un setState sur un
  // composant démonté si la Sidebar est re-rendue pendant la promesse.
  useEffect(() => {
    let cancelled = false
    window.blow.wiki
      .getFolder()
      .then((s) => {
        if (!cancelled) setStatus(s as WikiFolderStatusT)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleBuild(): Promise<void> {
    setBuilding(true)
    setFeedback(null)
    try {
      const r = (await window.blow.agents.runWikiBuilder()) as AgentWikiBuilderResultT
      setFeedback({
        kind: 'ok',
        message: `${r.operations.length} page${r.operations.length > 1 ? 's' : ''} mise${r.operations.length > 1 ? 's' : ''} à jour`
      })
      await refresh()
      setTimeout(() => setFeedback(null), 5000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFeedback({ kind: 'error', message: msg })
      setTimeout(() => setFeedback(null), 8000)
    } finally {
      setBuilding(false)
    }
  }

  const isConfigured = status?.folderPath != null && status.initialized

  // Version compacte : un seul icone ✦ (ou ∅ si non configuré). Clic
  // reconstruit le wiki, ou ouvre Settings.
  if (collapsed) {
    return (
      <div className="flex justify-center px-2">
        <button
          type="button"
          onClick={isConfigured ? () => void handleBuild() : onOpenWikiSettings}
          disabled={building || (isConfigured && status!.rawCount === 0)}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
          title={
            !isConfigured
              ? 'Mémoire : configurer le wiki'
              : status!.rawCount === 0
                ? 'Mémoire : aucune synthèse à traiter'
                : `Reconstruire le wiki (${status!.rawCount} raw → ${status!.wikiCount} pages)`
          }
        >
          {building ? '⏳' : isConfigured ? '✦' : '∅'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
          Mémoire
        </h3>
        {/* Raccourci → Paramètres > Wiki. Utile pour rentrer dans la
            config sans passer par l'engrenage du footer. */}
        <button
          type="button"
          onClick={onOpenWikiSettings}
          className="rounded-[var(--radius-sm)] px-1 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-secondary)]"
          title="Ouvrir les paramètres du Wiki"
          aria-label="Paramètres du Wiki"
        >
          ⚙
        </button>
      </div>

      {!isConfigured && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-[var(--fg-muted)]">
            Wiki non configuré.
          </span>
          <button
            type="button"
            onClick={onOpenWikiSettings}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            Configurer…
          </button>
        </div>
      )}

      {isConfigured && status && (
        <>
          <div className="flex items-center gap-2 text-[10px] text-[var(--fg-muted)]">
            <span title="synthèses brutes">{status.rawCount} raw</span>
            <span>·</span>
            <span title="pages wiki structurées">{status.wikiCount} pages</span>
          </div>
          <button
            type="button"
            onClick={() => void handleBuild()}
            disabled={building || status.rawCount === 0}
            className="rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              borderColor: 'var(--border)',
              color: 'var(--fg-secondary)'
            }}
            title={
              status.rawCount === 0
                ? 'Aucune synthèse à traiter — utilise ✦ dans le chat'
                : 'Reconstruire le wiki à partir des synthèses raw/'
            }
          >
            {building ? '⏳ Construction…' : '✦ Reconstruire le wiki'}
          </button>
          {feedback && (
            <div
              className="text-[9px]"
              style={{
                color: feedback.kind === 'error' ? '#f87171' : 'var(--fg-secondary)'
              }}
            >
              {feedback.kind === 'ok' ? '✓ ' : '✗ '}
              {feedback.message}
            </div>
          )}
        </>
      )}
    </div>
  )
}
