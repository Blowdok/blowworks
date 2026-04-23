import { useState } from 'react'
import type { WikiFolderStatusT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../../stores/wiki-store.js'

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
  const status = useWikiStore((s) => s.status)
  const setStoreStatus = useWikiStore((s) => s.setStatus)
  const refreshStore = useWikiStore((s) => s.refresh)
  // Centralisation Sprint 3 : le `building` vient du store, pas d'un
  // useState local — sinon deux points d'entrée (sidebar + settings)
  // peuvent lancer le builder en parallèle et l'un voit "idle" pendant
  // que l'autre tourne.
  const building = useWikiStore((s) => s.building)
  const buildFeedback = useWikiStore((s) => s.buildFeedback)
  const runWikiBuilder = useWikiStore((s) => s.runWikiBuilder)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChoose(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = (await window.blow.wiki.chooseFolder()) as WikiFolderStatusT | null
      // chooseFolder retourne le statut à jour → on push dans le store
      // directement, évite un refetch inutile. Si l'utilisateur annule
      // (next = null), on laisse le store tel quel.
      if (next) setStoreStatus(next)
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

  async function handleOpenRawInExplorer(): Promise<void> {
    try {
      await window.blow.wiki.openRawInExplorer()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // État de retour de l'import. Détaille succès vs erreurs par fichier
  // pour que l'utilisateur sache exactement ce qui a (ou pas) été ajouté.
  const [importReport, setImportReport] = useState<
    Array<{ targetName: string | null; error: string | null; sourcePath: string }> | null
  >(null)

  async function handleImportToRaw(): Promise<void> {
    setError(null)
    setImportReport(null)
    try {
      const r = (await window.blow.wiki.importToRaw()) as {
        canceled: boolean
        results: Array<{ targetName: string | null; error: string | null; sourcePath: string }>
      }
      if (r.canceled) return
      setImportReport(r.results)
      void refreshStore()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleBuildWiki(): Promise<void> {
    setError(null)
    await runWikiBuilder()
  }

  const isConfigured = status.folderPath != null && status.initialized

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

      {isConfigured && (
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
              onClick={() => void handleOpenRawInExplorer()}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-[11px] hover:bg-[var(--bg-tertiary)]"
              title="Ouvrir le sous-dossier raw/ — utile pour glisser-déposer des notes"
            >
              📂 Ouvrir raw/
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
              onClick={() => void refreshStore()}
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
              Importer dans raw/
            </div>
            <p className="text-[11px] text-[var(--fg-muted)]">
              Ajoute des fichiers <code>.md</code>, <code>.markdown</code> ou <code>.txt</code>
              externes au dossier <code>raw/</code>. Ils seront ingérés au prochain run du
              Wiki Builder, comme s&apos;ils provenaient du Synthétiseur.
            </p>
            <div>
              <button
                type="button"
                onClick={() => void handleImportToRaw()}
                className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px] font-medium"
                style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
              >
                📂 Importer des fichiers…
              </button>
            </div>
            {importReport && importReport.length > 0 && (
              <div className="mt-1 flex flex-col gap-1 text-[10px]">
                {importReport.map((r, i) => (
                  <div key={i} style={{ color: r.error ? '#f87171' : 'var(--fg-secondary)' }}>
                    {r.error ? '✗' : '✓'} {sourceBasename(r.sourcePath)}
                    {r.error ? ` — ${r.error}` : ` → raw/${r.targetName}`}
                  </div>
                ))}
              </div>
            )}
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
              {buildFeedback && (
                <span
                  className="text-[11px]"
                  style={{
                    color: buildFeedback.kind === 'error' ? '#f87171' : 'var(--fg-secondary)'
                  }}
                >
                  {buildFeedback.kind === 'error' ? '✗ ' : '✓ '}
                  {buildFeedback.message}
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

// Extrait le nom de fichier d'un chemin OS (gère les / Unix et \ Windows).
function sourceBasename(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1)
}
