import { memo } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  type TLBaseShape,
  type RecordProps
} from 'tldraw'
import ChatPortalView from '../../chat/ChatPortalView.js'

// Shape "Chat" : conversation IA (OpenRouter) persistée en SQLite, rendue
// hors-tldraw via `ShapePortalManager` — exactement comme TerminalShape
// et VSCodeShape. L'id de la shape == id de la conversation (ai_conversations.id),
// ce qui supprime tout mapping à maintenir.

type ChatShapeProps = {
  w: number
  h: number
  projectId: string | null
  // Dénormalisé depuis la conversation pour affichage rapide sans attendre
  // le chargement SQLite. La source de vérité reste `ai_conversations`.
  model: string
  // Toggles d'interaction (persistés dans les props → rechargés au boot).
  webSearchEnabled: boolean
  thinkingEnabled: boolean
}

export type ChatShape = TLBaseShape<'chat', ChatShapeProps>

// Enregistre la shape dans l'union globale de tldraw v4 (évite les casts any).
declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    chat: ChatShapeProps
  }
}

export class ChatShapeUtil extends BaseBoxShapeUtil<ChatShape> {
  static override type = 'chat' as const
  static override props: RecordProps<ChatShape> = {
    w: T.number,
    h: T.number,
    projectId: T.string.nullable(),
    model: T.string,
    webSearchEnabled: T.boolean,
    thinkingEnabled: T.boolean
  }

  override getDefaultProps(): ChatShape['props'] {
    return {
      w: 560,
      h: 480,
      projectId: null,
      // Le défaut sera écrasé au spawn par `spawnChatShape` qui lit le
      // modèle par défaut de `useChatStore.defaults`. Valeur ici = fallback
      // si le user crée une shape manuellement via API tldraw.
      model: 'anthropic/claude-sonnet-4-6',
      webSearchEnabled: false,
      thinkingEnabled: false
    }
  }

  override canEdit = (): boolean => true
  override canResize = (): boolean => true
  override isAspectRatioLocked = (): boolean => false

  // Minimums : assez large pour lire le markdown sans re-wrap excessif,
  // assez haut pour afficher au moins 3-4 messages + la zone de saisie.
  override onResize(
    shape: ChatShape,
    info: { scaleX: number; scaleY: number }
  ): { props: { w: number; h: number } } {
    return {
      props: {
        w: Math.max(420, shape.props.w * info.scaleX),
        h: Math.max(320, shape.props.h * info.scaleY)
      }
    }
  }

  // Placeholder transparent — pattern strictement identique à TerminalShape
  // et VSCodeShape : `ShapePortalManager` trouve la BCR via le data-attr
  // et y positionne le vrai contenu hors du layer tldraw.
  override component(shape: ChatShape) {
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          background: 'transparent',
          pointerEvents: 'none'
        }}
      >
        <div
          data-blowworks-shape-id={shape.id}
          style={{ width: '100%', height: '100%' }}
        />
      </HTMLContainer>
    )
  }

  override indicator(shape: ChatShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={10} ry={10} />
  }
}

// Contenu réel de la shape — rendu hors tldraw par ShapePortalManager.
// Mémorisé strictement sur `shape.id` + dimensions + props fonctionnelles
// pour éviter toute reinitialisation du textarea / scrollback markdown
// pendant un drag fluide (pattern VSCodeShape).
export const ChatPortalContent = memo(
  function ChatPortalContentImpl({ shape }: { shape: ChatShape }) {
    return <ChatPortalView shape={shape} />
  },
  (prev, next) =>
    prev.shape.id === next.shape.id &&
    prev.shape.props.w === next.shape.props.w &&
    prev.shape.props.h === next.shape.props.h &&
    prev.shape.props.projectId === next.shape.props.projectId &&
    prev.shape.props.model === next.shape.props.model &&
    prev.shape.props.webSearchEnabled === next.shape.props.webSearchEnabled &&
    prev.shape.props.thinkingEnabled === next.shape.props.thinkingEnabled
)
