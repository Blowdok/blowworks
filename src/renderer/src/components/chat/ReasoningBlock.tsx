import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownUrlTransform
} from '../../lib/markdown.js'

// Bloc pliable rendu dans la timeline pour un segment `reasoning` (chain-of-
// thought d'un modèle compatible Claude 3.7+/4, OpenAI o1/o3, Gemini
// Thinking, DeepSeek R1, Grok).
//
// État par défaut : REPLIÉ, que le reasoning soit en cours ou terminé.
// L'utilisateur peut le déplier à tout moment (pendant ou après le stream)
// pour voir le raisonnement du modèle.
//
// Pendant le stream (done=false) :
//   - Shimmer (bande lumineuse qui traverse le header) + label "en cours…"
//     qui pulse, pour signaler l'activité sans que l'user ait besoin de
//     déplier.
//   - Si déplié, curseur clignotant ▋ à la fin du markdown streamé.
// Une fois terminé (done=true) :
//   - Le shimmer s'arrête, label passe au compteur de mots (proxy d'ampleur
//     du raisonnement).
//
// Persistance : le content + done sont sérialisés dans segmentsJson au
// done du stream. Au reload, on ressuscite le bloc replié en done=true.

export default function ReasoningBlock({
  content,
  done
}: {
  content: string
  done: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={markdownUrlTransform}
      >
        {content.length > 0 ? content : ' '}
      </ReactMarkdown>
    ),
    [content]
  )

  // Compteur de mots simple (split whitespace). Non parfait pour CJK mais
  // suffit pour donner à l'utilisateur une idée de l'ampleur du raisonnement.
  const wordCount = useMemo(
    () => content.trim().split(/\s+/).filter(Boolean).length,
    [content]
  )

  return (
    <div
      className="my-2 overflow-hidden rounded-[var(--radius-sm)] border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg-tertiary)'
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="relative flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-primary)]"
        aria-expanded={expanded}
      >
        <span className="shrink-0 text-[13px]" aria-hidden>
          🧠
        </span>
        <span className="flex-1 font-medium">
          Raisonnement
          {done ? (
            <span className="ml-2 text-[10px] text-[var(--fg-muted)]">
              {wordCount} mot{wordCount > 1 ? 's' : ''}
            </span>
          ) : (
            <span className="ml-2 inline-block animate-pulse text-[10px] text-[var(--fg-muted)]">
              en cours…
            </span>
          )}
        </span>
        <span className="shrink-0 text-[9px] opacity-70" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>

        {/* Shimmer : bande de lumière cyan qui traverse le header pendant
            que le reasoning streame. Pointer-events none pour ne pas
            bloquer le clic du bouton. Disparaît au done. */}
        {!done && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              backgroundImage:
                'linear-gradient(90deg, transparent 0%, rgba(34, 211, 238, 0.18) 50%, transparent 100%)',
              backgroundSize: '200% 100%',
              animation: 'reasoning-shimmer 2.2s linear infinite'
            }}
          />
        )}
      </button>

      {expanded && (
        <div
          className="border-t px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <div
            className="markdown-body text-[12px] opacity-85"
            style={{ color: 'var(--fg-primary)' }}
          >
            {rendered}
            {!done && (
              <span className="animate-pulse text-[var(--fg-secondary)]">▋</span>
            )}
          </div>
        </div>
      )}

      {/* Keyframe inline : self-contained, évite de polluer le CSS global.
          N'injecte le style que si shimmer actif (léger coût DOM sinon). */}
      {!done && (
        <style>{`
          @keyframes reasoning-shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
          }
        `}</style>
      )}
    </div>
  )
}
