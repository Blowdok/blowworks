import { useState } from 'react'
import { useUIStore } from '../../stores/ui-store.js'

// Onglet Settings > Terminal : dossier de travail par défaut des nouveaux
// terminaux. Chaîne vide = résolution automatique côté main (Bureau, sinon
// home de l'utilisateur).

export default function TerminalSettingsTab(): React.ReactElement {
  const defaultCwd = useUIStore((s) => s.defaultTerminalCwd)
  const setDefaultCwd = useUIStore((s) => s.setDefaultTerminalCwd)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pickFolder(): Promise<void> {
    setError(null)
    setPicking(true)
    try {
      const folder = await window.blow.dialog.pickFolder({
        title: 'Dossier de travail par défaut des terminaux',
        defaultPath: defaultCwd || undefined
      })
      if (folder) setDefaultCwd(folder)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">
          Terminal
        </h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Dossier ouvert par défaut à la création d&apos;un nouveau terminal.
          Les terminaux existants conservent leur propre répertoire.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <label className="text-[12px] text-[var(--fg-secondary)]">
          Dossier par défaut
        </label>
        <div
          className="rounded-[var(--radius-sm)] border px-3 py-2 font-mono text-[11px]"
          style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
        >
          {defaultCwd || (
            <span className="text-[var(--fg-muted)]">
              Bureau de l&apos;utilisateur (automatique)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void pickFolder()}
            disabled={picking}
            className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
          >
            {picking ? '…' : 'Choisir un dossier…'}
          </button>
          {defaultCwd && (
            <button
              type="button"
              onClick={() => setDefaultCwd('')}
              className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              style={{ borderColor: 'var(--border)' }}
            >
              Réinitialiser (Bureau)
            </button>
          )}
        </div>
        {error && (
          <span className="text-[11px]" style={{ color: '#f87171' }}>
            {error}
          </span>
        )}
      </section>
    </div>
  )
}
