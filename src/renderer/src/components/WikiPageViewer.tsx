import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import { markdownRemarkPlugins, markdownRehypePlugins } from '../lib/markdown.js'
import { useWikiStore } from '../stores/wiki-store.js'

// Viewer markdown global des pages wiki. Monté une seule fois (dans
// Sidebar) et écoute `openPageName` depuis le wiki-store — n'importe
// quel composant peut déclencher l'ouverture via `openWikiPage(name)`.
//
// Pages suivantes dans la pile : Sprint 4 pourrait ajouter une nav
// précédent/suivant (historique), recherche inline, édition. Pour
// l'instant lecture seule.
export default function WikiPageViewer(): React.ReactElement | null {
  const pageName = useWikiStore((s) => s.openPageName)
  const closeWikiPage = useWikiStore((s) => s.closeWikiPage)
  const openWikiPage = useWikiStore((s) => s.openWikiPage)

  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset content/error quand pageName change (pattern render-reset
  // pour éviter le warning react-hooks/set-state-in-effect).
  const [lastName, setLastName] = useState(pageName)
  if (lastName !== pageName) {
    setLastName(pageName)
    setContent(null)
    setError(null)
  }

  useEffect(() => {
    if (!pageName) return
    let cancelled = false
    window.blow.wiki
      .readWiki(pageName)
      .then((c) => {
        if (!cancelled) setContent(c as string)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [pageName])

  // Fermeture sur Échap.
  useEffect(() => {
    if (!pageName) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeWikiPage()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pageName, closeWikiPage])

  if (!pageName) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/70" onClick={closeWikiPage} aria-hidden />
      <div
        className="relative m-auto flex h-[80vh] w-[min(720px,90vw)] flex-col overflow-hidden rounded-[var(--radius-md)] border shadow-2xl"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <code className="text-[12px] text-[var(--fg-muted)]">wiki/{pageName}</code>
          <button
            type="button"
            onClick={closeWikiPage}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
            aria-label="Fermer"
            title="Fermer (Échap)"
          >
            ×
          </button>
        </div>
        <div
          className="flex-1 overflow-y-auto px-5 py-4 text-[13px]"
          style={{ color: 'var(--fg-primary)' }}
        >
          {error && (
            <div className="text-[11px]" style={{ color: '#f87171' }}>
              {error}
            </div>
          )}
          {!error && content === null && (
            <div className="text-[11px] text-[var(--fg-muted)]">Chargement…</div>
          )}
          {content !== null && (
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={markdownRemarkPlugins}
                rehypePlugins={markdownRehypePlugins}
                components={{
                  // Les wikilinks `[[xxx]]` sont rendus par react-markdown
                  // comme du texte brut. On détecte et transforme dans le
                  // rendu `p`/`li` en passant par `a` ci-dessous, mais le
                  // pattern le plus robuste c'est : les liens markdown
                  // `[label](wiki-page://xxx)` sont interceptés → ouvrent
                  // la page visée dans le même viewer. Les liens
                  // `wiki/xxx.md` (texte) sont aussi captés.
                  a: ({ children, href, ...rest }) => {
                    if (href && href.startsWith('wiki-page://')) {
                      const target = href.slice('wiki-page://'.length)
                      return (
                        <a
                          {...rest}
                          href={href}
                          onClick={(e) => {
                            e.preventDefault()
                            openWikiPage(target)
                          }}
                          style={{ color: 'var(--fg-secondary)', cursor: 'pointer' }}
                        >
                          {children}
                        </a>
                      )
                    }
                    return (
                      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    )
                  }
                }}
              >
                {linkifyWikiRefs(content)}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// Transforme toutes les mentions textuelles `wiki/xxx/yyy.md` en liens
// markdown `[wiki/xxx/yyy.md](wiki-page://xxx/yyy.md)` et les wikilinks
// `[[page-slug]]` en liens `[[page-slug]](wiki-page://??)` (heuristique
// sans contexte : on suppose `concepts/page-slug.md` par défaut, pas
// idéal mais fonctionnel). Exporté pour pouvoir être réutilisé dans le
// chat (ChatMessageList).
export function linkifyWikiRefs(text: string): string {
  // Évite de re-linkifier le contenu qui est déjà à l'intérieur d'une
  // URL markdown (segment ](...)) ou d'un bloc code fenced ```.
  // Approche simple : split par code fence triple backtick, linkify
  // uniquement les segments hors-code.
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts
    .map((seg) => {
      if (seg.startsWith('```') && seg.endsWith('```')) return seg
      // wiki/xxx.md (chemin explicite)
      let s = seg.replace(
        /\bwiki\/([\w\-/]+\.md)\b/g,
        (_m, rel) => `[wiki/${rel}](wiki-page://${rel})`
      )
      // [[page-slug]] → [[page-slug]](wiki-page://concepts/page-slug.md)
      // Heuristique : on préfixe `concepts/` si pas déjà un chemin
      // (pas de `/` dans le slug) et on ajoute `.md`.
      s = s.replace(/\[\[([^\]|]+)\]\]/g, (_m, slug: string) => {
        const trimmed = slug.trim()
        const hasSlash = trimmed.includes('/')
        const hasExt = /\.md$/i.test(trimmed)
        const target = hasSlash ? trimmed : `concepts/${trimmed}`
        const withExt = hasExt ? target : `${target}.md`
        return `[[${trimmed}]](wiki-page://${withExt})`
      })
      return s
    })
    .join('')
}
