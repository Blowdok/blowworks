import { useCallback, useEffect, useState } from 'react'
import { useUIStore } from '../../stores/ui-store.js'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/search-engines.js'

// Onglet Settings > Navigateur : choix du moteur de recherche par défaut
// utilisé par BrowserShape (homepage des nouvelles shapes + résolution
// des requêtes barre d'URL) + gestion des extensions Chrome chargées dans
// la session `persist:browser`.

interface ExtensionInfo {
  id: string
  name: string
  version: string
  path: string
  manifestUrl: string | null
}

export default function BrowserSettingsTab(): React.ReactElement {
  const searchEngine = useUIStore((s) => s.searchEngine)
  const setSearchEngine = useUIStore((s) => s.setSearchEngine)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">Navigateur</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Moteur de recherche par défaut utilisé par les shapes Navigateur.
          S&apos;applique aux nouvelles shapes spawnées et à toute recherche
          tapée dans la barre d&apos;URL. Les shapes déjà ouvertes gardent
          leur page actuelle.
        </p>
        <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
          Note : le webview BlowWorks utilise une session Chromium isolée
          (cookies persistés sur disque, partition <code>persist:browser</code>).
          Pour synchroniser tes préférences Brave Search, connecte-toi à
          ton compte directement dans la shape Navigateur.
        </p>
      </header>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] text-[var(--fg-secondary)]">Moteur</legend>
        {SEARCH_ENGINES.map((engine) => (
          <SearchEngineRadio
            key={engine.id}
            id={engine.id}
            label={engine.label}
            homepage={engine.homepage}
            checked={engine.id === searchEngine}
            onSelect={() => setSearchEngine(engine.id)}
          />
        ))}
      </fieldset>

      <ExtensionsSection />
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Extensions

function ExtensionsSection(): React.ReactElement {
  const [exts, setExts] = useState<ExtensionInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await window.blow.browser.extensions.list()
      setExts(list)
    } catch (err) {
      console.warn('[browser-settings] list extensions échoué', err)
    }
  }, [])

  // Pattern annulable : un fetch lent ne peut pas écraser un montage
  // démonté ou un fetch ultérieur (StrictMode-safe).
  useEffect(() => {
    let cancelled = false
    window.blow.browser.extensions
      .list()
      .then((list) => {
        if (!cancelled) setExts(list)
      })
      .catch((err) => {
        console.warn('[browser-settings] list extensions échoué', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onInstall = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const folder = await window.blow.dialog.pickFolder({
        title: "Choisir un dossier d'extension Chrome (manifest.json à la racine)"
      })
      if (!folder) {
        setBusy(false)
        return
      }
      const result = await window.blow.browser.extensions.load(folder)
      if (!result.ok) {
        setError(result.error)
      } else {
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (id: string): Promise<void> => {
    setError(null)
    const result = await window.blow.browser.extensions.remove(id)
    if (!result.ok) {
      setError(result.error ?? "Suppression échouée.")
    }
    await refresh()
  }

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-baseline justify-between">
        <div>
          <h4 className="text-[12px] font-semibold text-[var(--fg-primary)]">
            Extensions Chrome
          </h4>
          <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
            Chargées dans la session des shapes Navigateur. Support complet
            MV2, partiel MV3 (service workers OK, certains <code>chrome.*</code>{' '}
            APIs limités).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onInstall()}
          disabled={busy}
          className="rounded border px-2 py-1 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          style={{
            borderColor: 'var(--border)',
            color: 'var(--fg-primary)'
          }}
        >
          {busy ? 'Installation…' : 'Installer un dossier…'}
        </button>
      </header>

      {error && (
        <div
          className="rounded border px-2 py-1.5 text-[11px]"
          style={{
            borderColor: '#7f1d1d',
            background: '#1f0a0a',
            color: '#fca5a5'
          }}
        >
          {error}
        </div>
      )}

      {exts.length === 0 ? (
        <div
          className="rounded border px-3 py-3 text-[11px] text-[var(--fg-muted)]"
          style={{ borderColor: 'var(--border)' }}
        >
          Aucune extension installée. Place un dossier d&apos;extension décompressé
          (avec <code>manifest.json</code> à la racine) puis clique sur{' '}
          <em>Installer un dossier</em>. Le redémarrage de BlowWorks rechargera
          automatiquement les extensions placées dans{' '}
          <code>userData/extensions/</code>.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {exts.map((ext) => (
            <li
              key={ext.id}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-[11px]"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[var(--fg-primary)]">
                  {ext.name}
                </div>
                <div className="truncate text-[10px] text-[var(--fg-muted)]">
                  v{ext.version} · <span className="font-mono">{ext.id}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onRemove(ext.id)}
                className="rounded px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
                title="Désinstaller"
              >
                Désinstaller
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[10px] text-[var(--fg-muted)]">
        Astuce : un changement d&apos;extension prend effet au prochain
        rechargement de la page dans la shape Navigateur.
      </p>
    </section>
  )
}

function SearchEngineRadio({
  id,
  label,
  homepage,
  checked,
  onSelect
}: {
  id: SearchEngineId
  label: string
  homepage: string
  checked: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <label
      className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2 transition-colors"
      style={{
        borderColor: checked ? 'var(--fg-secondary)' : 'var(--border)',
        background: checked ? 'var(--bg-tertiary)' : 'transparent'
      }}
    >
      <input
        type="radio"
        name="search-engine"
        value={id}
        checked={checked}
        onChange={onSelect}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--fg-secondary)]"
      />
      <div className="flex min-w-0 flex-col">
        <span
          className="text-[12px]"
          style={{
            color: checked ? 'var(--fg-secondary)' : 'var(--fg-primary)',
            fontWeight: checked ? 600 : 400
          }}
        >
          {label}
        </span>
        <span className="truncate text-[10px] text-[var(--fg-muted)]">
          {stripScheme(homepage)}
        </span>
      </div>
    </label>
  )
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}
