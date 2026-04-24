import { useEffect, useMemo, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownUrlTransform
} from '../../lib/markdown.js'
import type { AIMessageT } from '@shared/ipc-contract.js'
import CitationsList from './CitationsList.js'
import CodeBlock from './CodeBlock.js'
import ReasoningBlock from './ReasoningBlock.js'
import type { Segment, ToolTrace } from '../../stores/chat-store.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useEditorStore } from '../../stores/editor-store.js'
import { useWikiStore } from '../../stores/wiki-store.js'
import { linkifyWikiRefs } from '../WikiPageViewer.js'
import { spawnBrowserShape } from '../canvas/InfiniteCanvas.js'

interface ChatMessageListProps {
  messages: AIMessageT[]
  // Timeline du stream actif : mélange de segments `text` (markdown
  // streamé) et `tool` (badges d'actions IA). undefined = aucun stream
  // en cours. Le rendu entrelace les segments dans l'ordre de réception.
  streamingSegments?: Segment[]
  streamingError: string | null
  streamingCitations: string[] | undefined
  // Sprint 3 : callback "Filer cette réponse dans le wiki". Si fourni,
  // chaque MessageBubble assistant affiche un bouton 📥 qui relance
  // l'agent QA Filer sur ce seul message. Null = fonctionnalité désactivée
  // (wiki non configuré, par exemple).
  onFileBack?: (messageId: string) => void
  fileBackInProgress?: string | null
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
  streamingSegments,
  streamingError,
  streamingCitations,
  onFileBack,
  fileBackInProgress
}: ChatMessageListProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isAtBottomRef = useRef(true)
  // Map des timelines persistantes (post-stream) indexée par messageId.
  // Utilisée par chaque MessageBubble assistant pour reconstituer le
  // déroulé entrelacé des actions IA après la fin du streaming.
  const messageSegments = useChatStore((s) => s.messageSegments)

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
  }, [messages, streamingSegments])

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

  const hasMessages = messages.length > 0 || (streamingSegments && streamingSegments.length > 0)

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
          <MessageBubble
            key={m.id}
            message={m}
            onFileBack={onFileBack}
            fileBackInProgress={fileBackInProgress === m.id}
            segments={messageSegments.get(m.id)}
          />
        ))}

        {streamingSegments && streamingSegments.length > 0 && (
          <StreamingBubble
            segments={streamingSegments}
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
//   - `<a>` → intercepte le clic pour ouvrir l'URL dans une nouvelle
//     BrowserShape (navigateur interne) au lieu d'ouvrir le navigateur
//     système ou de naviguer la frame TOP (qui écraserait la SPA). Les
//     liens non-http(s) (ancres, mailto:) gardent le comportement natif.
//     Un garde `will-navigate` côté main couvre aussi ce cas en défense
//     en profondeur, mais on préfère faire le routage dès le renderer
//     pour éviter un aller-retour IPC inutile.
// Défini HORS des composants React → référence stable, pas de re-render
// inutile de ReactMarkdown à chaque frame du streaming.
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, href, ...rest }) => {
    // Liens `wiki-page://xxx.md` produits par linkifyWikiRefs → ouvre
    // le viewer markdown interne (WikiPageViewer). Évite d'ouvrir un
    // browser pour du contenu local.
    if (href && href.startsWith('wiki-page://')) {
      const target = href.slice('wiki-page://'.length)
      return (
        <a
          {...rest}
          href={href}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            useWikiStore.getState().openWikiPage(target)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            color: 'var(--fg-secondary)',
            cursor: 'pointer',
            textDecoration: 'underline',
            textDecorationStyle: 'dashed',
            textUnderlineOffset: '3px'
          }}
          title={`Ouvrir wiki/${target}`}
        >
          {children}
        </a>
      )
    }
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (!href) return
          if (!/^https?:\/\//i.test(href)) return
          e.preventDefault()
          e.stopPropagation()
          const editor = useEditorStore.getState().editor
          if (editor) spawnBrowserShape(editor, href)
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    )
  }
}

// Bulle d'un message commité en DB (user ou assistant). Si une timeline
// de segments est fournie (assistant uniquement, via
// `chatStore.messageSegments`), on rend les segments ENTRELACÉS : texte
// markdown puis badge d'action puis texte puis badge, dans l'ordre
// chronologique. Sinon on rend `message.content` en un seul bloc markdown.
function MessageBubble({
  message,
  onFileBack,
  fileBackInProgress,
  segments
}: {
  message: AIMessageT
  onFileBack?: (messageId: string) => void
  fileBackInProgress?: boolean
  segments?: Segment[]
}): React.ReactElement {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const showFileBack = isAssistant && onFileBack && message.content.length > 60
  const useTimeline = isAssistant && segments !== undefined && segments.length > 0

  return (
    <div className={`mb-4 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        // Largeur des bulles — différente selon le rôle pour aligner
        // les réponses assistant sur la colonne de lecture (bord gauche
        // ET droit alignés sur la capsule de saisie) tout en gardant
        // l'effet « bulle » pour les messages user à droite.
        className={`group rounded-[var(--radius-md)] ${
          isUser ? 'max-w-[92%] border px-3 py-2' : 'w-full max-w-full px-1 py-1'
        }`}
        style={{
          background: isUser ? 'var(--bg-tertiary)' : 'transparent',
          borderColor: isUser ? 'var(--border)' : undefined,
          color: 'var(--fg-primary)'
        }}
      >
        {useTimeline ? (
          <SegmentsTimeline segments={segments!} />
        ) : isAssistant ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={markdownRemarkPlugins}
              rehypePlugins={markdownRehypePlugins}
              urlTransform={markdownUrlTransform}
              components={markdownComponents}
            >
              {linkifyWikiRefs(message.content)}
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
        {showFileBack && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => onFileBack!(message.id)}
              disabled={fileBackInProgress}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--fg-muted)] opacity-60 transition-opacity hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
              title="Convertit cette réponse en page wiki permanente dans wiki/qa/ (agent QA Filer → demande confirmation avant écriture)"
              aria-label="Filer dans le wiki"
            >
              {fileBackInProgress ? '⏳ Filage en cours…' : '📥 Ajouter au wiki (qa/)'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// Bulle pour le message assistant en cours de streaming : timeline
// entrelacée de segments (texte markdown + badges d'actions) dans l'ordre
// chronologique du raisonnement. Cursor clignotant à la fin pour signaler
// que le stream est toujours actif.
function StreamingBubble({
  segments,
  error,
  citations
}: {
  segments: Segment[]
  error: string | null
  citations: string[] | undefined
}): React.ReactElement {
  return (
    <div className="mb-4 flex justify-start">
      <div
        // Remplit la colonne de lecture (aligné sur MessageBubble assistant)
        // → le bord droit du texte coïncide avec le bord droit de la capsule
        // de saisie, évitant l'effet « rivière » désalignée pendant le stream.
        className="w-full max-w-full rounded-[var(--radius-md)] px-1 py-1"
        style={{ color: 'var(--fg-primary)' }}
      >
        <SegmentsTimeline segments={segments} withCursor />
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

// Rendu de la timeline entrelacée : parcourt les segments et rend un bloc
// markdown pour chaque `text` et un badge pour chaque `tool`. Si
// `withCursor`, ajoute un curseur clignotant à la fin du DERNIER segment
// `text` pour matérialiser la progression du stream.
function SegmentsTimeline({
  segments,
  withCursor = false
}: {
  segments: Segment[]
  withCursor?: boolean
}): React.ReactElement {
  // Trouve l'index du dernier segment text pour y coller le curseur.
  const lastTextIdx = withCursor
    ? (() => {
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].kind === 'text') return i
        }
        return -1
      })()
    : -1
  // Si withCursor et qu'aucun segment text dans la timeline, on peut
  // afficher un curseur en queue pour signaler que le stream continue.
  // SAUF si le dernier segment est un `reasoning` en cours — dans ce cas
  // le shimmer du ReasoningBlock suffit comme indicateur d'activité, le
  // ▋ en plus serait redondant et visuellement bruyant.
  const lastSeg = segments[segments.length - 1]
  const lastIsActiveReasoning =
    lastSeg && lastSeg.kind === 'reasoning' && !lastSeg.done
  const trailingCursor =
    withCursor && lastTextIdx === -1 && segments.length > 0 && !lastIsActiveReasoning

  return (
    <div className="markdown-body">
      {segments.map((seg, i) => {
        if (seg.kind === 'tool') {
          return (
            <div key={`tool-${seg.trace.id}`} className="my-2">
              <ToolTraceBadge trace={seg.trace} />
            </div>
          )
        }
        if (seg.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={`reasoning-${i}`}
              content={seg.content}
              done={seg.done}
            />
          )
        }
        // kind === 'text'
        const isLast = i === lastTextIdx
        return (
          <TextSegmentRendered
            key={`text-${i}`}
            content={seg.content}
            cursor={isLast && withCursor}
          />
        )
      })}
      {trailingCursor && (
        <span className="animate-pulse text-[var(--fg-secondary)]">▋</span>
      )}
    </div>
  )
}

// Un segment texte rendu en markdown, memoisé sur son content pour éviter
// de refabriquer l'arbre à chaque delta d'un AUTRE segment.
function TextSegmentRendered({
  content,
  cursor
}: {
  content: string
  cursor: boolean
}): React.ReactElement {
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={markdownUrlTransform}
        components={markdownComponents}
      >
        {content.length > 0 ? linkifyWikiRefs(content) : ' '}
      </ReactMarkdown>
    ),
    [content]
  )
  return (
    <>
      {rendered}
      {cursor && <span className="animate-pulse text-[var(--fg-secondary)]">▋</span>}
    </>
  )
}

// Badge compact représentant l'état d'un tool call en cours. Les icônes
// suivent le cycle de vie : ⌛ pending/running, ⚠️ awaiting-confirm,
// ✓ success, ✗ error, ⛔ refused.
function ToolTraceBadge({ trace }: { trace: ToolTrace }): React.ReactElement {
  const icon =
    trace.status === 'success'
      ? '✓'
      : trace.status === 'error'
        ? '✗'
        : trace.status === 'refused'
          ? '⛔'
          : trace.status === 'awaiting-confirm'
            ? '⚠️'
            : '⌛'
  const color =
    trace.status === 'success'
      ? 'var(--fg-secondary)'
      : trace.status === 'error' || trace.status === 'refused'
        ? '#f87171'
        : trace.status === 'awaiting-confirm'
          ? '#f59e0b'
          : 'var(--fg-muted)'
  const label = summarizeToolCall(trace.name, trace.arguments)
  return (
    <div
      className="flex items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1 text-[11px]"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}
    >
      <span style={{ color }}>{icon}</span>
      <code className="font-mono text-[10px] text-[var(--fg-muted)]">{trace.name}</code>
      <span className="truncate text-[var(--fg-primary)]">{label}</span>
    </div>
  )
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'read_wiki_page' && typeof args.name === 'string') return `wiki/${args.name}`
  if (name === 'write_wiki_page' && typeof args.name === 'string') return `wiki/${args.name}`
  if (name === 'delete_wiki_page' && typeof args.name === 'string') return `wiki/${args.name}`
  if (name === 'rename_wiki_page' && typeof args.from === 'string' && typeof args.to === 'string')
    return `${args.from} → ${args.to}`
  if (name === 'search_wiki' && typeof args.pattern === 'string') return `/${args.pattern}/`
  if (name === 'list_wiki_pages')
    return typeof args.subdir === 'string' ? `subdir: ${args.subdir}` : 'all pages'
  return ''
}
