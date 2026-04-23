import { useEffect, useState } from 'react'
import type {
  WikiFolderStatusT,
  AgentWikiBuilderResultT
} from '@shared/ipc-contract.js'

// Onglet Paramètres > Wiki.
// Deux états :
//   1. Non configuré → gros bouton « Choisir un dossier » + explainer.
//   2. Configuré     → chemin affiché, stats (raw/wiki), actions : changer,
//                       ouvrir dans l'explorateur, copier le chemin.
//
// Onboarding paresseux : aucun défaut, aucune modale au boot. C'est ici
// que tout se passe. Tant que `folderPath` est null, les agents (lot 3)
// et toute opération wiki se comportent en no-op.

export default function WikiSettingsTab(): React.ReactElement {
  const [status, setStatus] = useState<WikiFolderStatusT | null>(null)
  const [busy, setBusy] = useState(false)
  const [building, setBuilding] = useState(false)
  const [buildResult, setBuildResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [])

  async function refresh(): Promise<void> {
    try {
      const s = (await window.blow.wiki.getFolder()) as WikiFolderStatusT
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleChoose(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = (await window.blow.wiki.chooseFolder()) as WikiFolderStatusT | null
      if (next) setStatus(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleOpenInExplorer(): Promise<void> {
    try {
      await window.blow.wiki.openFolderInExplorer()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Déclenche l'agent Wiki Builder : il lit toutes les synthèses raw/*.md
  // et produit/met à jour les pages structurées dans wiki/. Manuel — pas
  // d'auto-scheduler pour garder le coût API sous contrôle.
  async function handleBuildWiki(): Promise<void> {
    setBuilding(true)
    setBuildResult(null)
    setError(null)
    try {
      const r = (await window.blow.agents.runWikiBuilder()) as AgentWikiBuilderResultT
      setBuildResult(
        `${r.operations.length} page${r.operations.length > 1 ? 's' : ''} mise${r.operations.length > 1 ? 's' : ''} à jour`
      )
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBuilding(false)
    }
  }

  const isConfigured = status?.folderPath != null && status.initialized

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">Wiki · mémoire long-terme</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Dossier local où BlowWorks persiste la mémoire partagée de vos conversations IA,
          inspiré du{' '}
          <a
            href="https://github.com/karpathy/llm-wiki"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--fg-secondary)] underline"
          >
            llm-wiki de Karpathy
          </a>
          . Les agents (lot 3) synthétiseront les conversations dans <code>raw/</code>
          puis les refactoreront en pages structurées dans <code>wiki/</code>.
        </p>
      </header>

      {!isConfigured && (
        <div
          className="flex flex-col items-start gap-3 rounded-[var(--radius-sm)] border border-dashed px-4 py-6"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}
        >
          <div className="text-[12px] text-[var(--fg-muted)]">
            Aucun dossier choisi. Les agents et l&apos;injection de mémoire dans les conversations
            sont inactifs tant que ce n&apos;est pas configuré.
          </div>
          <button
            type="button"
            onClick={() => void handleChoose()}
            disabled={busy}
            className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          >
            {busy ? '…' : 'Choisir un dossier Wiki'}
          </button>
        </div>
      )}

      {isConfigured && status && (
        <>
          <div
            className="rounded-[var(--radius-sm)] border px-3 py-2 text-[12px]"
            style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          >
            ✓ Wiki configuré et initialisé.
          </div>

          <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border p-3 text-[12px]" style={{ borderColor: 'var(--border)' }}>
            <Row label="Dossier">
              <code
                className="block break-all rounded border bg-[var(--bg-tertiary)] px-2 py-1 text-[11px]"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
              >
                {status.folderPath}
              </code>
            </Row>
            <Row label="Synthèses brutes (raw/)">
              <span className="text-[var(--fg-primary)]">{status.rawCount}</span>
            </Row>
            <Row label="Pages wiki (wiki/)">
              <span className="text-[var(--fg-primary)]">{status.wikiCount}</span>
            </Row>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleOpenInExplorer()}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-[11px] hover:bg-[var(--bg-tertiary)]"
            >
              Ouvrir dans l&apos;explorateur
            </button>
            <button
              type="button"
              onClick={() => void handleChoose()}
              disabled={busy}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? '…' : 'Changer de dossier'}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-[11px] hover:bg-[var(--bg-tertiary)]"
              title="Rafraîchir les stats"
            >
              ↻ Rafraîchir
            </button>
          </div>

          <div
            className="mt-2 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
              Wiki Builder
            </div>
            <p className="text-[11px] text-[var(--fg-muted)]">
              Relit toutes les synthèses <code>raw/</code> et met à jour les pages structurées
              dans <code>wiki/</code>. Appel manuel — pensez à lancer après quelques synthèses
              pour voir le wiki se construire.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleBuildWiki()}
                disabled={building || status.rawCount === 0}
                className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
              >
                {building ? '⏳ Construction…' : '✦ Reconstruire le wiki'}
              </button>
              {buildResult && (
                <span className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>
                  ✓ {buildResult}
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="text-[11px]" style={{ color: '#f87171' }}>
          {error}
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-48 shrink-0 text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
