import { useEffect, useState, useRef } from 'react'
import { useEditor, createShapeId, type TLShapeId } from 'tldraw'
import type { ChatShape } from '../canvas/shapes/ChatShape.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useProjectStore } from '../../stores/project-store.js'
import ChatMessageList from './ChatMessageList.js'
import ChatInput from './ChatInput.js'
import ModelSelector from './ModelSelector.js'
import {
  useShapeBorderState,
  getShapeBorderStyle
} from '../../lib/use-shape-border-state.js'

// Vue complète du portail d'une ChatShape :
//   ┌ header : titre + sélecteur modèle + projet + boutons "+ Nouveau", "⋯"
//   ├ historique scrollable (ChatMessageList + streaming bubble)
//   └ zone de saisie (ChatInput)
//
// Le composant est monté dans le portail HORS tldraw (cf. ShapePortalManager)
// et hérite de `pointer-events: none` sur le conteneur root — on réactive
// explicitement sur chaque élément interactif (pattern TerminalShape).

interface ChatPortalViewProps {
  shape: ChatShape
}

export default function ChatPortalView({ shape }: ChatPortalViewProps): React.ReactElement {
  const editor = useEditor()
  const projects = useProjectStore((s) => s.projects)

  const conversation = useChatStore((s) => s.conversations.get(shape.id))
  const activeStream = useChatStore((s) => s.activeStreams.get(shape.id))
  const models = useChatStore((s) => s.models)
  const modelsLoading = useChatStore((s) => s.modelsLoading)
  const apiKeyStatus = useChatStore((s) => s.apiKeyStatus)
  const defaults = useChatStore((s) => s.defaults)

  const sendMessage = useChatStore((s) => s.sendMessage)
  const cancelStream = useChatStore((s) => s.cancelStream)
  const ensureConversation = useChatStore((s) => s.ensureConversation)
  const updateStoreConversation = useChatStore((s) => s.updateConversation)
  const refreshModels = useChatStore((s) => s.refreshModels)

  const [draft, setDraft] = useState('')
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)

  const assignedProject = projects.find((p) => p.id === shape.props.projectId) ?? null
  const hasKey = apiKeyStatus.openrouter
  const isStreaming = activeStream !== undefined

  // Charge la conversation au mount. Si elle n'existe pas côté DB (cas
  // rare : restauration d'un snapshot tldraw dont la DB a été vidée),
  // on la recrée à partir des props de la shape.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    void ensureConversation(shape.id, {
      model: shape.props.model,
      projectId: shape.props.projectId
    })
  }, [shape.id, shape.props.model, shape.props.projectId, ensureConversation])

  // Si le user n'a pas encore chargé la liste des modèles (clé API
  // ajoutée après le boot), on la récupère dès qu'elle devient dispo.
  useEffect(() => {
    if (hasKey && models.length === 0 && !modelsLoading) {
      void refreshModels()
    }
  }, [hasKey, models.length, modelsLoading, refreshModels])

  function setProjectId(projectId: string | null): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { projectId }
    })
    void updateStoreConversation({ id: shape.id, projectId })
    setProjectDropdownOpen(false)
  }

  function setModel(modelId: string): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { model: modelId }
    })
    void updateStoreConversation({ id: shape.id, model: modelId })
  }

  function toggleWebSearch(): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { webSearchEnabled: !shape.props.webSearchEnabled }
    })
  }

  function toggleThinking(): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { thinkingEnabled: !shape.props.thinkingEnabled }
    })
  }

  function handleSubmit(): void {
    const content = draft.trim()
    if (!content || isStreaming || !hasKey) return
    setDraft('')
    void sendMessage(shape.id, content, {
      model: shape.props.model,
      temperature: defaults.temperature,
      webSearchEnabled: shape.props.webSearchEnabled && apiKeyStatus.tavily,
      maxTokens: defaults.maxTokens
    })
  }

  function handleCancel(): void {
    void cancelStream(shape.id)
  }

  // "Nouveau" : spawn une nouvelle ChatShape décalée de 32px en bas-droite
  // de la shape courante (évite superposition). Hérite du modèle courant.
  async function handleNewConversation(): Promise<void> {
    const newId = createShapeId()
    try {
      await window.blow.ai.createConversation({
        id: newId,
        model: shape.props.model,
        projectId: shape.props.projectId,
        temperature: defaults.temperature
      })
    } catch (e) {
      console.error('[chat] échec création nouvelle conversation', e)
      return
    }
    editor.createShape<ChatShape>({
      id: newId as TLShapeId,
      type: 'chat',
      x: shape.x + shape.props.w + 48,
      y: shape.y,
      props: {
        w: shape.props.w,
        h: shape.props.h,
        projectId: shape.props.projectId,
        model: shape.props.model,
        webSearchEnabled: shape.props.webSearchEnabled,
        thinkingEnabled: shape.props.thinkingEnabled
      }
    })
    editor.setSelectedShapes([newId as TLShapeId])
  }

  const disabledReason = !apiKeyStatus.encryptionAvailable
    ? 'Chiffrement système indisponible — impossible de stocker la clé API.'
    : !hasKey
      ? 'Aucune clé OpenRouter configurée — ouvrez Paramètres ⚙ pour la définir.'
      : undefined

  const title = conversation?.conversation.title || 'Nouvelle conversation'
  const messages = conversation?.messages ?? []

  // Citations : affichées dans la StreamingBubble pendant le stream (cf.
  // ChatMessageList). Elles ne sont pas persistées en DB au lot 1 (viendra
  // au lot 3) — donc dès que la conv est rechargée depuis la DB (au `done`),
  // elles disparaissent. Comportement acceptable : l'utilisateur a vu les
  // sources pendant le live.

  // Surface unifiée Chat ⇄ canvas tldraw : #101011 partout (wrapper, header,
  // zone de saisie) → couture visuelle éliminée. La bordure du wrapper est
  // dynamique (hover / sélection / fade 5 s / projet) — gérée par le hook
  // partagé `useShapeBorderState`.
  const shapeSurface = 'var(--shape-surface, #101011)'
  const borderState = useShapeBorderState(shape.id)
  const borderStyle = getShapeBorderStyle(borderState, assignedProject?.color ?? null)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'hidden',
        background: shapeSurface,
        border: borderStyle.border,
        boxShadow: borderStyle.boxShadow,
        transition: borderStyle.transition,
        borderRadius: 'var(--radius-md, 8px)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Header 28px — pattern TerminalShape : boutons interactifs en
          pointer-events auto, tout le reste laisse tldraw recevoir le
          pointerdown pour drag. Aucune bordure basse visible : on reste
          dans la teinte unifiée #101011. */}
      <div
        data-shape-header
        className="relative flex h-7 shrink-0 items-center justify-between gap-2 px-2 text-[11px]"
        style={{
          background: shapeSurface,
          color: 'var(--fg-primary)',
          pointerEvents: 'none'
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="shrink-0"
            style={{ color: 'var(--fg-secondary)', fontSize: 10 }}
          >
            ▣
          </span>
          <span className="truncate text-[11px] text-[var(--fg-primary)]">{title}</span>
        </div>

        <div
          className="flex shrink-0 items-center gap-1"
          style={{ pointerEvents: 'auto' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ModelSelector
            models={models}
            currentModelId={shape.props.model}
            loading={modelsLoading}
            onSelect={setModel}
            onRefresh={() => void refreshModels(true)}
          />

          <div className="relative">
            <button
              type="button"
              onClick={() => setProjectDropdownOpen((v) => !v)}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--bg-tertiary)]"
              style={{
                color: assignedProject ? assignedProject.color : 'var(--fg-muted)'
              }}
              title="Assigner à un projet"
            >
              {assignedProject ? `● ${assignedProject.name}` : '○ projet'}
            </button>
            {projectDropdownOpen && (
              <div
                className="absolute right-0 top-7 z-10 min-w-[180px] overflow-hidden rounded border text-[11px] shadow-lg"
                style={{
                  background: 'var(--bg-secondary)',
                  borderColor: 'var(--border)'
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setProjectId(null)}
                  className="block w-full px-2 py-1.5 text-left text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  ○ Aucun projet
                </button>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProjectId(p.id)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)]"
                    style={{ color: p.color }}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                    <span className="truncate text-[var(--fg-primary)]">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => void handleNewConversation()}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)]"
            title="Nouvelle conversation (dupliquer la config courante)"
          >
            + new
          </button>
        </div>
      </div>

      {/* Historique scrollable (flex:1 → prend tout l'espace vertical dispo). */}
      <ChatMessageList
        messages={messages}
        streamingContent={activeStream?.content ?? null}
        streamingError={activeStream?.error ?? null}
        streamingCitations={activeStream?.citations}
      />

      {/* Zone de saisie fixée en bas. */}
      <ChatInput
        value={draft}
        onChange={setDraft}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        isStreaming={isStreaming}
        disabled={!hasKey || !apiKeyStatus.encryptionAvailable}
        disabledReason={disabledReason}
        webSearchEnabled={shape.props.webSearchEnabled}
        onToggleWebSearch={toggleWebSearch}
        thinkingEnabled={shape.props.thinkingEnabled}
        onToggleThinking={toggleThinking}
      />
    </div>
  )
}
