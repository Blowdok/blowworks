import { useEffect, useMemo, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { markdownRemarkPlugins, markdownRehypePlugins } from '../../lib/markdown.js'
import type { AIMessageT } from '@shared/ipc-contract.js'
import CitationsList from './CitationsList.js'
import CodeBlock from './CodeBlock.js'

interface ChatMessageListProps {
  messages: AIMessageT[]
  // Texte en cours de streaming pour le dernier message assistant à venir.
  // Null si aucun stream actif.
  streamingContent: string | null
  streamingError: string | null
  streamingCitations: string[] | undefined
}

// Zone scrollable de l'historique de conversation. Les messages user sont
// alignés à droite avec un fond légèrement contrasté ; les messages
// assistant prennent toute la largeur avec rendu markdown + code blocks.
//
// Auto-scroll : on suit le bas quand l'utilisateur y était déjà. S'il a
// scrollé vers le haut pour relire, on NE force PAS le scroll à chaque
// nouveau chunk — respect de l'intention de lecture.
export default function ChatMessageList({
  messages,
  streamingContent,
  streamingError,
  streamingCitations
}: ChatMessageListProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isAtBottomRef = useRef(true)

  // Observe le scroll pour détecter si l'utilisateur est proche du bas
  // (tolérance 48 px). Seuls les auto-scrolls valident cet état ; un
  // scroll manuel vers le haut met le flag à false jusqu'au prochain
  // retour en bas.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      isAtBottomRef.current = distanceFromBottom < 48
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll déclenché par nouveaux messages OU chunks de streaming.
  // Exige que l'utilisateur soit déjà en bas — sinon on le laisse lire.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!isAtBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, streamingContent])

  // Auto-copie sur sélection — pattern hérité du TerminalShape (convention
  // xterm/mintty Linux) : toute sélection finalisée à la souris est
  // immédiatement copiée dans le presse-papiers, sans Ctrl+C explicite.
  // Déclenchée sur `mouseup` pour attraper la sélection STABLE (pas des
  // extensions intermédiaires pendant un drag). On filtre sur le
  // conteneur courant pour ne rien copier venu d'une autre ChatShape
  // ou d'un autre endroit de l'app.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMouseUp = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const text = sel.toString()
      if (text.trim().length === 0) return
      // Vérifie que la sélection appartient bien à CE conteneur — évite
      // de copier une sélection d'une autre zone de l'app.
      const range = sel.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) return
      void navigator.clipboard.writeText(text).catch(() => {
        /* best-effort : si le presse-papiers refuse, on n'alerte pas
           pour ne pas polluer l'UX (la sélection visuelle reste active,
           l'utilisateur peut toujours faire Ctrl+C). */
      })
    }
    el.addEventListener('mouseup', onMouseUp)
    return () => el.removeEventListener('mouseup', onMouseUp)
  }, [])

  const hasMessages = messages.length > 0 || streamingContent !== null

  return (
    <div
      ref={containerRef}
      className="hide-scrollbar flex-1 overflow-y-auto px-6 py-3 text-sm"
      style={{
        color: 'var(--fg-primary)',
        // Le scroll vit DANS le portail, pas dans le canvas tldraw.
        // pointerEvents auto : le user doit pouvoir scroller / sélectionner
        // du texte pour le copier.
        pointerEvents: 'auto',
        // user-select: text essentiel — sans lui, aucun navigateur
        // n'autorise de sélection à la souris dans la zone messages
        // (l'héritage `pointer-events: none` du parent portail peut
        // faire chuter user-select à `none` dans Chromium).
        userSelect: 'text',
        WebkitUserSelect: 'text'
      }}
      // Intentionnellement PAS de `onPointerDown={stopPropagation}` ici :
      // `pointer-events: auto` suffit déjà à empêcher tldraw de recevoir
      // le pointerdown (il est écrasé par cette zone au hit-test), et le
      // `stopPropagation` React bloquait silencieusement la sélection
      // native du texte à la souris dans Chromium (drag-select annulé
      // avant que `mousemove` n'étende la range). Le wheel lui reste
      // stoppé pour éviter le zoom canvas pendant un scroll intra-chat.
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Colonne de lecture centrée adaptative (pattern Claude.ai / ChatGPT) :
          max-width 720 px + margin auto → sur un Chat étroit la colonne prend
          toute la largeur (le padding du parent fournit l'air), sur un Chat
          large les messages se centrent avec des marges latérales qui
          grossissent automatiquement, pour une longueur de ligne de lecture
          confortable (~75 caractères) quelle que soit la taille de la shape.
          `min-h-full` garantit que l'empty state reste centré verticalement
          quand la conversation est vide. */}
      <div className="mx-auto min-h-full w-full max-w-[720px]">
        {!hasMessages && (
          <div className="flex h-full items-center justify-center text-center text-[var(--fg-muted)]">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.2em]">Nouvelle conversation</div>
              <div className="text-[13px]">
                Posez votre question ci-dessous — la réponse apparaîtra ici en live.
              </div>
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {streamingContent !== null && (
          <StreamingBubble
            content={streamingContent}
            error={streamingError}
            citations={streamingCitations}
          />
        )}
      </div>
    </div>
  )
}

// Override react-markdown :
//   - `<pre>` → `<CodeBlock>` (header langage + copier + aperçu HTML).
//   - `<a>` → force `target="_blank"` + `rel="noopener noreferrer"` pour
//     que le clic emprunte le chemin `window.open` → `setWindowOpenHandler`
//     → `shell.openExternal` (ouverture navigateur système). SANS cet
//     override, un clic sur un `<a href>` nu provoque une navigation TOP-
//     frame qui EFFACE toute la SPA BlowWorks. Un garde `will-navigate`
//     côté main (`src/main/window.ts`) couvre aussi ce cas en défense en
//     profondeur, mais on préfère le comportement "nouveau navigateur"
//     dès le renderer pour éviter un aller-retour IPC inutile.
// Défini HORS des composants React → référence stable, pas de re-render
// inutile de ReactMarkdown à chaque frame du streaming.
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, href, ...rest }) => (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Stop pointerdown pour préserver la sélection du texte dans la
      // bulle — sans ça, le pointerdown sur un lien peut annuler une
      // range de sélection en cours.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

// Bulle d'un message commité en DB (user ou assistant).
function MessageBubble({ message }: { message: AIMessageT }): React.ReactElement {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'

  return (
    <div className={`mb-4 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        // Largeur des bulles — différente selon le rôle pour aligner
        // les réponses assistant sur la colonne de lecture (bord gauche
        // ET droit alignés sur la capsule de saisie) tout en gardant
        // l'effet « bulle » pour les messages user à droite.
        className={`rounded-[var(--radius-md)] ${
          isUser ? 'max-w-[92%] border px-3 py-2' : 'w-full max-w-full px-1 py-1'
        }`}
        style={{
          background: isUser ? 'var(--bg-tertiary)' : 'transparent',
          borderColor: isUser ? 'var(--border)' : undefined,
          color: 'var(--fg-primary)'
        }}
      >
        {isAssistant ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={markdownRemarkPlugins}
              rehypePlugins={markdownRehypePlugins}
              components={markdownComponents}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div
            className="whitespace-pre-wrap text-[14px] leading-relaxed"
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
          >
            {message.content}
          </div>
        )}
      </div>
    </div>
  )
}

// Bulle pour le message assistant en cours de streaming : cursor clignotant,
// markdown rendu en live (pas de buffer — `react-markdown` tolère bien les
// petits deltas tant qu'il y a un re-render par chunk).
function StreamingBubble({
  content,
  error,
  citations
}: {
  content: string
  error: string | null
  citations: string[] | undefined
}): React.ReactElement {
  // Memo du rendu : évite de refabriquer l'arbre markdown à chaque delta
  // si le texte cumulé n'a pas changé (cas des chunks vides/keep-alive).
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={markdownComponents}
      >
        {content.length > 0 ? content : ' '}
      </ReactMarkdown>
    ),
    [content]
  )

  return (
    <div className="mb-4 flex justify-start">
      <div
        // Remplit la colonne de lecture (aligné sur MessageBubble assistant)
        // → le bord droit du texte coïncide avec le bord droit de la capsule
        // de saisie, évitant l'effet « rivière » désalignée pendant le stream.
        className="w-full max-w-full rounded-[var(--radius-md)] px-1 py-1"
        style={{ color: 'var(--fg-primary)' }}
      >
        <div className="markdown-body">
          {rendered}
          <span className="animate-pulse text-[var(--fg-secondary)]">▋</span>
        </div>
        {error && (
          <div
            className="mt-2 rounded-[var(--radius-sm)] border px-2 py-1 text-[11px]"
            style={{ borderColor: '#f87171', color: '#f87171' }}
          >
            {error}
          </div>
        )}
        {citations && citations.length > 0 && <CitationsList urls={citations} />}
      </div>
    </div>
  )
}
