import { useState } from 'react'
import type { LintReportT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../stores/wiki-store.js'

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
  const status = useWikiStore((s) => s.status)
  const building = useWikiStore((s) => s.building)
  const feedback = useWikiStore((s) => s.buildFeedback)
  const runWikiBuilder = useWikiStore((s) => s.runWikiBuilder)
  const setSidebarMode = useWikiStore((s) => s.setSidebarMode)
  const refreshStatus = useWikiStore((s) => s.refresh)

  const [linting, setLinting] = useState(false)
  const [lintResult, setLintResult] = useState<
    { kind: 'ok' | 'issues' | 'error'; message: string } | null
  >(null)

  async function handleBuild(): Promise<void> {
    await runWikiBuilder()
  }

  async function handleLint(): Promise<void> {
    setLinting(true)
    setLintResult(null)
    try {
      const report = (await window.blow.agents.runLint()) as LintReportT
      const highCount = report.issues.filter((i) => i.severity === 'high').length
      setLintResult({
        kind: report.issues.length === 0 ? 'ok' : 'issues',
        message:
          report.issues.length === 0
            ? report.summary
            : `${report.issues.length} issue${report.issues.length > 1 ? 's' : ''} (${highCount} critique${highCount > 1 ? 's' : ''}) → audit/`
      })
      setTimeout(() => setLintResult(null), 8000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLintResult({ kind: 'error', message: msg })
      setTimeout(() => setLintResult(null), 8000)
    } finally {
      setLinting(false)
    }
  }

  async function handleImportToRaw(): Promise<void> {
    try {
      const r = (await window.blow.wiki.importToRaw()) as {
        canceled: boolean
        results: Array<{ targetName: string | null; error: string | null; sourcePath: string }>
      }
      if (r.canceled) return
      void refreshStatus()
    } catch (e) {
      console.warn('[memory] import failed', e)
    }
  }

  const isConfigured = status.folderPath != null && status.initialized

  // Version compacte : un seul icone ✦ (ou ∅ si non configuré). Clic
  // reconstruit le wiki, ou ouvre Settings.
  if (collapsed) {
    return (
      <div className="flex justify-center px-2">
        <button
          type="button"
          onClick={isConfigured ? () => void handleBuild() : onOpenWikiSettings}
          disabled={building || (isConfigured && status.rawCount === 0)}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
          title={
            !isConfigured
              ? 'Mémoire : configurer le wiki'
              : status.rawCount === 0
                ? 'Mémoire : aucune synthèse à traiter'
                : `Reconstruire le wiki (${status.rawCount} raw → ${status.wikiCount} pages)`
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
        <div className="flex items-center gap-1">
          {isConfigured && (
            <button
              type="button"
              onClick={() => setSidebarMode('wiki-explorer')}
              className="rounded-[var(--radius-sm)] px-1 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-secondary)]"
              title="Explorateur wiki — bascule la sidebar en mode arborescence"
              aria-label="Explorateur wiki"
            >
              📖
            </button>
          )}
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

      {isConfigured && (
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
                ? "Aucune synthèse à traiter — utilise ✦ dans le chat ou importe un fichier dans raw/"
                : 'Reconstruire le wiki à partir des synthèses raw/ (peut prendre plusieurs minutes)'
            }
          >
            {building ? '⏳ Construction…' : '✦ Reconstruire le wiki'}
          </button>
          <button
            type="button"
            onClick={() => void handleImportToRaw()}
            disabled={building}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            title="Importer un .md, .txt, .html ou .pdf dans raw/ — converti automatiquement en markdown avant ingestion par le Wiki Builder"
          >
            📂 Importer dans raw
          </button>
          <button
            type="button"
            onClick={() => void handleLint()}
            disabled={linting || building || status.wikiCount === 0}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            title="Audit du wiki (orphelins, liens brisés, contradictions). Rapport écrit dans audit/."
          >
            {linting ? '⏳ Lint…' : '🩺 Health check'}
          </button>
          {lintResult && (
            <div
              className="text-[9px]"
              style={{
                color:
                  lintResult.kind === 'error'
                    ? '#f87171'
                    : lintResult.kind === 'issues'
                      ? '#f59e0b'
                      : 'var(--fg-secondary)'
              }}
            >
              {lintResult.kind === 'ok' ? '✓ ' : lintResult.kind === 'error' ? '✗ ' : '⚠ '}
              {lintResult.message}
            </div>
          )}
          {building && (
            <div className="text-[9px] text-[var(--fg-muted)]">
              Le modèle traite {status.rawCount} synthèse{status.rawCount > 1 ? 's' : ''} — peut durer plusieurs minutes. Timeout à 5 min.
            </div>
          )}
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
