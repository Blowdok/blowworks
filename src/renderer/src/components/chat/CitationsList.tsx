// Liste des sources web utilisées par Tavily pour une réponse.
// Affichée sous le dernier message assistant quand la conversation a
// activé la recherche web. Les URLs sont cliquables — via
// `shell.openExternal` elles s'ouvrent dans le navigateur système
// (comportement global du main window, cf. `src/main/window.ts`).

interface CitationsListProps {
  urls: string[]
}

export default function CitationsList({ urls }: CitationsListProps): React.ReactElement | null {
  if (urls.length === 0) return null

  function formatUrl(url: string): string {
    try {
      const u = new URL(url)
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')
    } catch {
      return url
    }
  }

  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5 border-t pt-2"
      style={{
        borderColor: 'var(--border)',
        pointerEvents: 'auto'
      }}
    >
      <span className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
        Sources ({urls.length})
      </span>
      {urls.map((url, i) => (
        <a
          key={i}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="max-w-[240px] truncate rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)] transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
          title={url}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {i + 1}. {formatUrl(url)}
        </a>
      ))}
    </div>
  )
}
