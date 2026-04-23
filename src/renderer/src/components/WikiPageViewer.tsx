import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownUrlTransform
} from '../lib/markdown.js'
import { useWikiStore } from '../stores/wiki-store.js'

// Éditeur + aperçu markdown d'une page wiki. Monté une seule fois (dans
// Sidebar) et écoute `openPageName` depuis le wiki-store.
//
// Ce n'est plus une modale plein écran mais un PANNEAU dans la zone
// canvas (target = `#canvas-overlay-root`). Sidebar et header restent
// accessibles pendant l'édition.
//
// Trois modes d'affichage :
//   - split   : éditeur gauche | aperçu droite (défaut)
//   - edit    : éditeur plein cadre
//   - preview : aperçu plein cadre (lecture seule)
//
// Sauvegarde manuelle via `window.blow.wiki.writeWiki`. Pas d'auto-save
// pour respecter la logique "Wiki Builder owned the wiki" — l'utilisateur
// peut toucher à la main mais c'est une action explicite.

type Mode = 'split' | 'edit' | 'preview'

export default function WikiPageViewer(): React.ReactElement | null {
  const pageName = useWikiStore((s) => s.openPageName)
  const closeWikiPage = useWikiStore((s) => s.closeWikiPage)
  const openWikiPage = useWikiStore((s) => s.openWikiPage)

  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('split')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Largeur du side panel en fraction (0..1) de la zone canvas. Permet
  // de voir ses shapes (chat, terminal, etc.) sur la gauche pendant
  // qu'on consulte/édite une page wiki à droite. Redimensionnable via
  // un handle de drag à la bordure gauche du panel.
  const [widthFraction, setWidthFraction] = useState(0.5)
  const [resizing, setResizing] = useState(false)

  const dirty = original !== null && draft !== original

  // Reset content/error quand pageName change — render-reset pattern
  // pour éviter `react-hooks/set-state-in-effect`.
  const [lastName, setLastName] = useState(pageName)
  if (lastName !== pageName) {
    setLastName(pageName)
    setOriginal(null)
    setDraft('')
    setError(null)
    setSaving(false)
    setSavedAt(null)
  }

  useEffect(() => {
    if (!pageName) return
    let cancelled = false
    window.blow.wiki
      .readWiki(pageName)
      .then((c) => {
        if (!cancelled) {
          const str = c as string
          setOriginal(str)
          setDraft(str)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [pageName])

  // Fermeture sur Échap (avec garde-dirty).
  useEffect(() => {
    if (!pageName) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
      }
      // Ctrl/Cmd+S = sauver
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        if (dirty && !saving) void handleSave()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // `handleClose` et `handleSave` sont recréés à chaque render, on
    // évite de les mettre en deps — seul `pageName`/`dirty`/`saving`
    // déterminent la logique.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageName, dirty, saving])

  function handleClose(): void {
    if (dirty) {
      const ok = window.confirm(
        'Vous avez des modifications non sauvegardées. Fermer quand même et les perdre ?'
      )
      if (!ok) return
    }
    closeWikiPage()
  }

  async function handleSave(): Promise<void> {
    if (!pageName || !dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      await window.blow.wiki.writeWiki(pageName, draft)
      setOriginal(draft)
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const rendered = useMemo(() => {
    if (original === null) return null
    return (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={markdownUrlTransform}
        components={{
          a: ({ children, href, ...rest }) => {
            if (href && href.startsWith('wiki-page://')) {
              const target = href.slice('wiki-page://'.length)
              return (
                <a
                  {...rest}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    // Garde dirty : si le draft contient des modifs non
                    // sauvegardées, on demande confirmation AVANT de
                    // naviguer. Sans ce guard, le render-reset écrase
                    // silencieusement le draft au changement de pageName.
                    if (dirty) {
                      const ok = window.confirm(
                        `Modifications non sauvegardées sur "${pageName}". Quitter sans enregistrer ?`
                      )
                      if (!ok) return
                    }
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
        {linkifyWikiRefs(draft)}
      </ReactMarkdown>
    )
  }, [draft, openWikiPage, original])

  if (!pageName) return null

  const mountTarget = document.getElementById('canvas-overlay-root') ?? document.body

  // Handler global de drag pour le resize handle. Monté sur window le
  // temps du drag pour continuer à suivre le curseur même si on sort
  // momentanément du handle (UX classique resize de panel).
  function startResize(e: React.PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)
    const container = mountTarget
    function onMove(ev: PointerEvent): void {
      const rect = container.getBoundingClientRect()
      // Panel aligné à gauche : fraction = (pointerX - leftEdge) / totalWidth
      const frac = (ev.clientX - rect.left) / rect.width
      // Clamp : min 22% (lecture rapide), max 92% (quasi plein)
      const clamped = Math.max(0.22, Math.min(0.92, frac))
      setWidthFraction(clamped)
    }
    function onUp(): void {
      setResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return createPortal(
    <div
      className="pointer-events-auto absolute bottom-0 left-0 top-0 flex flex-col border-r shadow-2xl"
      role="dialog"
      aria-modal="false"
      style={{
        width: `${widthFraction * 100}%`,
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)'
      }}
    >
      {/* Handle de resize : barre verticale de 5 px à la bordure droite
          du panel (puisque le panel est aligné à gauche). Pointer-events
          auto, cursor col-resize. */}
      <div
        onPointerDown={startResize}
        className="absolute bottom-0 right-0 top-0 z-10 w-[5px] cursor-col-resize hover:bg-[var(--fg-secondary)]"
        style={{
          background: resizing ? 'var(--fg-secondary)' : 'transparent',
          transition: resizing ? 'none' : 'background 120ms ease-out',
          transform: 'translateX(2px)'
        }}
        title="Glisser pour redimensionner"
      />
      <header
        className="flex shrink-0 items-center gap-3 border-b px-3 py-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={handleClose}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
          title="Fermer (Échap)"
          aria-label="Fermer"
        >
          ← Fermer
        </button>
        <code className="flex-1 truncate text-[12px] text-[var(--fg-muted)]">
          wiki/{pageName}
          {dirty && <span className="ml-2" style={{ color: '#f59e0b' }}>●</span>}
        </code>

        {/* Toggle mode */}
        <div className="flex items-center gap-0 rounded-[var(--radius-sm)] border" style={{ borderColor: 'var(--border)' }}>
          <ModeButton active={mode === 'edit'} onClick={() => setMode('edit')} title="Édition seule">
            ✎
          </ModeButton>
          <ModeButton active={mode === 'split'} onClick={() => setMode('split')} title="Éditeur + aperçu">
            ⊟
          </ModeButton>
          <ModeButton active={mode === 'preview'} onClick={() => setMode('preview')} title="Aperçu seul">
            ◉
          </ModeButton>
        </div>

        {savedAt && (
          <span className="text-[10px]" style={{ color: 'var(--fg-secondary)' }}>
            ✓ Sauvegardé
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          title="Enregistrer (Ctrl+S)"
        >
          {saving ? '⏳' : '💾 Enregistrer'}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {error && (
          <div className="flex h-full w-full items-center justify-center text-[12px]" style={{ color: '#f87171' }}>
            {error}
          </div>
        )}
        {!error && original === null && (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-[var(--fg-muted)]">
            Chargement…
          </div>
        )}
        {!error && original !== null && (
          <>
            {(mode === 'edit' || mode === 'split') && (
              <div
                className={`flex min-h-0 flex-col ${mode === 'split' ? 'w-1/2 border-r' : 'flex-1'}`}
                style={{ borderColor: 'var(--border)' }}
              >
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="h-full w-full resize-none border-0 bg-transparent px-5 py-4 font-mono text-[12px] leading-[1.6] outline-none"
                  style={{
                    color: 'var(--fg-primary)',
                    background: 'var(--bg-primary)'
                  }}
                />
              </div>
            )}
            {(mode === 'preview' || mode === 'split') && (
              <div
                className={`min-h-0 overflow-y-auto px-5 py-4 text-[13px] ${mode === 'split' ? 'w-1/2' : 'flex-1'}`}
                style={{ color: 'var(--fg-primary)', background: 'var(--bg-secondary)' }}
              >
                <div className="markdown-body mx-auto max-w-[720px]">{rendered}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    mountTarget
  )
}

function ModeButton({
  active,
  onClick,
  children,
  title
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="px-2 py-0.5 text-[11px] transition-colors"
      style={{
        background: active ? 'var(--bg-tertiary)' : 'transparent',
        color: active ? 'var(--fg-primary)' : 'var(--fg-muted)'
      }}
    >
      {children}
    </button>
  )
}

// Transforme les références wiki en liens markdown cliquables résolus
// vers le viewer interne via le scheme `wiki-page://`. Gère 3 syntaxes :
//
//   1. `wiki/xxx/yyy.md`   → chemin explicite, cible directement le FS
//   2. `[[slug]]`          → wikilink à la Obsidian, résolu par basename
//   3. `[slug]`            → fallback (single-bracket) quand l'IA a écrit
//                            la syntaxe "reference-style link" par erreur
//                            au lieu de `[[...]]`. Heuristique : slug
//                            kebab-case pur, 2-60 chars, non suivi de
//                            `(` (vrai lien markdown) ou `:` (definition).
//
// Heuristique de résolution sans contexte : `concepts/<slug>.md` par
// défaut si pas de slash. Le viewer utilise `readWiki(name)` qui plante
// si le fichier n'existe pas — l'erreur est affichée proprement.
//
// Exporté pour être réutilisé dans le chat (ChatMessageList) et dans
// les previews du WikiGraphModal.
export function linkifyWikiRefs(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts
    .map((seg) => {
      if (seg.startsWith('```') && seg.endsWith('```')) return seg
      // 1. `wiki/xxx.md` → lien explicite
      let s = seg.replace(
        /\bwiki\/([\w\-/]+\.md)\b/g,
        (_m, rel) => `[wiki/${rel}](wiki-page://${rel})`
      )
      // 2. `[[slug]]` (double bracket) — syntaxe canonique
      s = s.replace(/\[\[([^\]|]+)\]\]/g, (_m, slug: string) =>
        buildWikiLink(slug.trim(), `[[${slug.trim()}]]`)
      )
      // 3. `[slug]` (single bracket) — fallback pour les IAs qui oublient
      //    le double crochet. On refuse explicitement :
      //    - `[label](url)` → markdown link standard (suivi de `(`)
      //    - `[ref]: url`   → reference-style link definition (suivi de `:`)
      //    - `[^1]`         → footnote (commence par `^`)
      //    - `[x]` / `[ ]`  → task list (1 char)
      //    - tout ce qui contient chiffre pur, espaces ou caractères
      //      non-slug (lettres/chiffres/tirets uniquement)
      s = s.replace(
        /(?<!\[)\[([a-zà-ÿ][a-zà-ÿ0-9-]{1,60}[a-zà-ÿ0-9])\](?![\](:])/gi,
        (match, slug: string) => {
          const trimmed = slug.trim()
          // Exclusions complémentaires
          if (/^\d+$/.test(trimmed)) return match // "[42]"
          if (/^[x ]$/i.test(trimmed)) return match // "[x]" / "[ ]"
          if (trimmed.startsWith('^')) return match // footnote
          return buildWikiLink(trimmed, `[${trimmed}]`)
        }
      )
      return s
    })
    .join('')
}

// Construit un lien markdown vers wiki-page:// à partir d'un slug brut.
// `label` = texte visible conservé (garde `[[slug]]` ou `[slug]` selon
// la syntaxe d'origine, pour que le visuel markdown reste cohérent).
function buildWikiLink(slug: string, label: string): string {
  const hasSlash = slug.includes('/')
  const hasExt = /\.md$/i.test(slug)
  const target = hasSlash ? slug : `concepts/${slug}`
  const withExt = hasExt ? target : `${target}.md`
  return `${label}(wiki-page://${withExt})`
}
