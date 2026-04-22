import { useMemo, useState, type ReactNode } from 'react'

// Wrapper autour d'un bloc ```lang ... ``` rendu par react-markdown.
// Header sobre avec :
//   - Nom du langage (rehype-highlight l'injecte en classe `language-xxx`)
//   - Bouton "Copier" (API Clipboard native)
//   - Bouton "Aperçu" si le langage est HTML → iframe sandboxée avec srcDoc
//
// react-markdown passe ce composant comme override de <pre>. Les enfants
// sont un <code class="language-xxx hljs"> rendu par rehype-highlight.

interface CodeBlockProps {
  children?: ReactNode
  className?: string
}

// Langages pour lesquels un aperçu visuel a du sens. Le SVG est également
// rendu, mais on le traite comme HTML pour la simplicité (l'iframe le
// parse sans problème). `svg` est donc absorbé par le cas `html`.
const PREVIEWABLE_LANGS = new Set(['html', 'xml', 'svg'])

export default function CodeBlock({ children }: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const lang = extractLanguage(children) ?? 'code'
  const canPreview = PREVIEWABLE_LANGS.has(lang.toLowerCase())

  // Extrait le texte brut depuis l'arbre React des enfants — pas via un
  // ref DOM, car la lecture d'un ref pendant le render est interdite
  // (lint `react-hooks/refs`) et ferait lire le DOM avant mount lors du
  // 1er rendu de l'aperçu. Le texte est le contenu du <code> qui wrappe
  // le bloc de code source (rehype-highlight ajoute des spans colorés
  // mais le texte cumulé reste identique à la source).
  const rawText = useMemo(() => extractText(children), [children])

  async function handleCopy(): Promise<void> {
    const text = rawText
    if (text.length === 0) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback : navigator.clipboard peut être bloqué hors contexte
      // sécurisé. Utiliser un <textarea> temporaire + execCommand.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } finally {
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div
      // Bloc de code en immersion totale : bordure fondue au canvas
      // (#101011 identique à la surface Chat) → seul le header de langage
      // reste visible (fond #1a1a1b), le corps du code coule dans le fond
      // canvas sans cadre perceptible. La classe `border` + borderColor en
      // shape-surface est conservée (plutôt que `border-0`) pour préserver
      // le box-sizing 1px et le clipping des coins arrondis du header.
      className="my-3 overflow-hidden rounded-[var(--radius-md)] border"
      style={{ borderColor: 'var(--shape-surface, #101011)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-widest"
        style={{
          background: '#1a1a1b',
          color: 'var(--fg-muted)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.06)'
        }}
      >
        <span className="font-mono">{lang}</span>
        <div className="flex items-center gap-1">
          {canPreview && (
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--bg-tertiary)]"
              style={{
                color: previewOpen ? 'var(--fg-secondary)' : 'var(--fg-muted)',
                pointerEvents: 'auto'
              }}
              title={previewOpen ? 'Revenir au code' : 'Aperçu du rendu HTML'}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {previewOpen ? '‹/› Code' : '👁 Aperçu'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{
              color: copied ? 'var(--fg-secondary)' : 'var(--fg-muted)',
              pointerEvents: 'auto'
            }}
            title="Copier le bloc de code"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {copied ? '✓ Copié' : '⧉ Copier'}
          </button>
        </div>
      </div>

      {/* Le <pre> reste TOUJOURS monté (caché en aperçu) pour préserver
          la coloration hljs déjà calculée par rehype-highlight, et pour
          éviter un flash au toggle Code/Aperçu. */}
      <pre
        style={{
          margin: 0,
          display: previewOpen ? 'none' : undefined
        }}
      >
        {children}
      </pre>

      {previewOpen && canPreview && <HtmlPreview source={rawText} />}
    </div>
  )
}

// Aperçu HTML isolé via iframe sandboxée. Sécurité :
//   - `sandbox="allow-same-origin"` absent → pas d'accès au DOM parent
//   - Pas de `allow-scripts` → aucun JS exécuté (rendu statique de l'HTML)
//     ce qui suffit pour visualiser la structure / styles / SVG générés
//     par l'IA sans risquer un xss dans notre renderer Electron.
//   - `srcDoc` plutôt que data URL : pas de limite de taille, pas
//     d'encoding à gérer, Chromium parse directement le string.
function HtmlPreview({ source }: { source: string }): React.ReactElement {
  return (
    <div
      style={{
        background: '#ffffff',
        minHeight: 120,
        maxHeight: 480
      }}
    >
      <iframe
        title="Aperçu HTML"
        srcDoc={source}
        sandbox=""
        style={{
          width: '100%',
          height: 400,
          border: 'none',
          display: 'block',
          // Bloque la propagation du scroll iframe vers le canvas tldraw :
          // à l'intérieur de l'iframe, le compositeur Chromium gère le
          // scroll nativement, donc pas de leak de wheel events.
          pointerEvents: 'auto'
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}

// Parcourt les enfants pour extraire `language-xxx` de la classe du <code>.
// `children` est typiquement un ReactElement <code className="language-ts hljs">.
function extractLanguage(children: ReactNode): string | null {
  if (!children || typeof children !== 'object') return null
  // React node single : accéder à .props.className
  const node = children as { props?: { className?: string } }
  const cls = node.props?.className ?? ''
  const match = /language-([a-zA-Z0-9+#\-_]+)/.exec(cls)
  return match?.[1] ?? null
}

// Extrait récursivement le texte brut depuis l'arbre ReactNode du `<code>`.
// react-markdown passe en enfants soit :
//   - une chaîne directe (bloc sans coloration)
//   - un <code> élément React dont les enfants peuvent être string OU
//     tableau de string/ReactElement (spans hljs après coloration)
// On concatène récursivement tous les `string` et `number` rencontrés.
function extractText(node: ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  const el = node as { props?: { children?: ReactNode } }
  if (el.props && 'children' in el.props) return extractText(el.props.children)
  return ''
}
