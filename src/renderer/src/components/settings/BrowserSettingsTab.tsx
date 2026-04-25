import { useUIStore } from '../../stores/ui-store.js'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/search-engines.js'

// Onglet Settings > Navigateur : choix du moteur de recherche par défaut
// utilisé par BrowserShape (homepage des nouvelles shapes + résolution
// des requêtes barre d'URL).
//
// Les shapes existantes gardent leur URL persistée — le changement
// s'applique aux NOUVELLES navigations (homepage de spawn, recherches
// tapées dans la barre).

export default function BrowserSettingsTab(): React.ReactElement {
  const searchEngine = useUIStore((s) => s.searchEngine)
  const setSearchEngine = useUIStore((s) => s.setSearchEngine)

  return (
    <div className="flex flex-col gap-4">
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
    </div>
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
