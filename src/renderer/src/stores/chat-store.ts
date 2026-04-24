import { create } from 'zustand'
import type {
  AIConversationT,
  AIConversationSummaryT,
  AIMessageT,
  AIModelT,
  AIApiKeyStatusT,
  AIDefaultsT
} from '@shared/ipc-contract.js'

// Store Zustand pour les conversations IA côté renderer.
//
// Sources de vérité :
//   - La DB SQLite (main) détient la vérité ultime sur conversations
//     et messages — le renderer cache mais ne décide pas.
//   - Le stream en cours vit dans `activeStreams[convId]` : c'est la
//     seule donnée UNIQUEMENT renderer (non persistée), rafraîchie à
//     chaque chunk reçu via `window.blow.ai.onChunk`.
//
// Pattern : au `done: true`, on refetch la conversation depuis la DB
// pour avoir le message assistant final avec ses usage/tokens, puis on
// efface l'entrée activeStreams.

// Trace d'un tool call au cours d'un stream. `result` vide tant que le
// tool n'a pas renvoyé. `pendingConfirm: true` quand le modèle attend la
// décision utilisateur sur un tool destructif.
export interface ToolTrace {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error' | 'awaiting-confirm' | 'refused'
  result?: string
  error?: string
}

// Segment de timeline entrelacée : bloc de texte (delta streamé), action
// IA (tool call) ou raisonnement (chain-of-thought). Construit en ordre
// CHRONOLOGIQUE au fur et à mesure du stream — permet de reproduire le
// déroulé exact du modèle ("Je vais chercher..." → action → "Parfait,
// laisse-moi lire..." → action → réponse finale), avec un bloc pliable
// de reasoning intercalé pour les modèles qui le supportent.
//
// `reasoning.done` : `false` pendant le stream (shimmer actif côté UI),
// `true` au done du stream ou quand un autre type de segment suit.
export type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; trace: ToolTrace }
  | { kind: 'reasoning'; content: string; done: boolean }

export interface StreamState {
  requestId: string
  // Segments ordonnés remplaçant `content + toolTraces` flat : permet au
  // renderer d'intercaler texte narratif et badges d'actions comme dans
  // le raisonnement réel du LLM.
  segments: Segment[]
  startedAt: number
  citations?: string[]
  error?: string
  // Demande de confirmation en cours (toolCallId, args) pour qu'un
  // composant UI puisse afficher le dialog. Null quand rien en attente.
  awaitingConfirm: { id: string; name: string; arguments: Record<string, unknown> } | null
}

// Helpers pour construire/mettre à jour la liste de segments depuis le
// chunk listener. Logique : un delta texte prolonge le dernier segment
// s'il est 'text', sinon crée un nouveau segment 'text'. Un toolCall
// crée toujours un nouveau segment 'tool'. Un toolResult met à jour le
// segment 'tool' existant par id (ne crée rien de nouveau).
export function appendTextDelta(segments: Segment[], delta: string): Segment[] {
  if (delta.length === 0) return segments
  const last = segments[segments.length - 1]
  if (last && last.kind === 'text') {
    return [
      ...segments.slice(0, -1),
      { kind: 'text', content: last.content + delta }
    ]
  }
  return [...segments, { kind: 'text', content: delta }]
}

export function upsertToolSegment(
  segments: Segment[],
  trace: ToolTrace
): Segment[] {
  const idx = segments.findIndex(
    (s) => s.kind === 'tool' && s.trace.id === trace.id
  )
  if (idx === -1) return [...segments, { kind: 'tool', trace }]
  const next = [...segments]
  next[idx] = { kind: 'tool', trace }
  return next
}

// Append un delta de reasoning. Si le DERNIER segment est `reasoning`
// et pas encore `done`, on prolonge son content — le reasoning est un
// flux continu tant que le modèle n'a pas commencé à produire du texte
// ou appelé un tool. Dès qu'un autre type de segment arrive, le bloc
// reasoning passe automatiquement à `done: true` via closeOpenReasoning
// (appelé côté chunk listener avant d'ajouter texte ou tool).
export function appendReasoningDelta(segments: Segment[], delta: string): Segment[] {
  if (delta.length === 0) return segments
  const last = segments[segments.length - 1]
  if (last && last.kind === 'reasoning' && !last.done) {
    return [
      ...segments.slice(0, -1),
      { kind: 'reasoning', content: last.content + delta, done: false }
    ]
  }
  return [...segments, { kind: 'reasoning', content: delta, done: false }]
}

// Marque tous les segments `reasoning` encore ouverts comme terminés.
// Appelé (a) à la fin du stream, (b) juste avant d'ajouter un segment
// texte ou tool après un reasoning — pour que la shimmer UI s'arrête
// et que le bloc puisse se replier automatiquement.
export function closeOpenReasoning(segments: Segment[]): Segment[] {
  let changed = false
  const next = segments.map((s) => {
    if (s.kind === 'reasoning' && !s.done) {
      changed = true
      return { ...s, done: true }
    }
    return s
  })
  return changed ? next : segments
}

// Helper de lecture : concatène tous les segments 'text' pour obtenir
// le contenu markdown complet du message (utile pour le `content` à
// poster en DB ou pour debug). Ignore les segments 'tool'.
export function segmentsToText(segments: Segment[]): string {
  return segments
    .filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.content)
    .join('')
}

// Parse la colonne `segmentsJson` d'un message et retourne les segments
// typés. Tolérant : si le JSON est corrompu ou a un shape inattendu,
// retourne null plutôt que de throw (on tombera en fallback markdown
// plain via `message.content`).
function parseSegmentsJson(json: string | null | undefined): Segment[] | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    // Validation light : on garde les entries qui ont un kind connu.
    return parsed
      .filter(
        (s: unknown): s is Segment =>
          typeof s === 'object' &&
          s !== null &&
          'kind' in s &&
          ((s as { kind: string }).kind === 'text' ||
            (s as { kind: string }).kind === 'tool' ||
            (s as { kind: string }).kind === 'reasoning')
      )
      .map((s) => {
        // Sécurité : si un segment `reasoning` persisté manque son flag
        // `done`, on le force à true (sinon la shimmer tournerait sur
        // des messages rechargés depuis la DB).
        if (s.kind === 'reasoning' && typeof (s as { done?: unknown }).done !== 'boolean') {
          return { ...(s as Segment), done: true } as Segment
        }
        return s
      })
  } catch {
    return null
  }
}

// Parcourt une liste de messages fraîchement fetchés depuis la DB et
// retourne une NOUVELLE Map messageSegments enrichie avec les timelines
// décodées depuis `segmentsJson`. Merge (pas écrase) pour préserver les
// entries des autres conversations déjà hydratées en session.
function hydrateSegmentsFromMessages(
  previous: Map<string, Segment[]>,
  messages: { id: string; segmentsJson?: string | null }[]
): Map<string, Segment[]> {
  const next = new Map(previous)
  for (const m of messages) {
    const segments = parseSegmentsJson(m.segmentsJson)
    if (segments && segments.length > 0) {
      next.set(m.id, segments)
    }
  }
  return next
}

export interface ChatConversation {
  conversation: AIConversationT
  messages: AIMessageT[]
}

interface ChatStore {
  hydrated: boolean
  apiKeyStatus: AIApiKeyStatusT
  defaults: AIDefaultsT
  models: AIModelT[]
  modelsLoading: boolean
  conversations: Map<string, ChatConversation>
  // Index de TOUTES les conversations (métadata + messagesCount) alimenté
  // par `ai.listConversations`. Utilisé par le dropdown historique — pas
  // de chargement des messages tant que la conv n'est pas sélectionnée.
  allConversations: Map<string, AIConversationSummaryT>
  activeStreams: Map<string, StreamState>
  // Timeline de segments (texte + actions) attachée au message assistant
  // qui l'a produite. Renseignée à la fin du stream pour que MessageBubble
  // affiche le déroulé entrelacé même après la fin du streaming.
  // Volatile (non persisté en DB) — suffit pour la session courante.
  messageSegments: Map<string, Segment[]>

  hydrate: () => Promise<void>
  refreshApiKeyStatus: () => Promise<void>
  refreshModels: (forceRefresh?: boolean) => Promise<void>
  refreshDefaults: () => Promise<void>
  refreshAllConversations: () => Promise<void>

  // Conversation lifecycle
  ensureConversation: (
    id: string,
    opts: { model: string; projectId?: string | null; system?: string | null; temperature?: number }
  ) => Promise<AIConversationT>
  loadConversation: (id: string) => Promise<ChatConversation | null>
  updateConversation: (input: {
    id: string
    title?: string
    model?: string
    system?: string | null
    temperature?: number
    projectId?: string | null
  }) => Promise<void>
  removeConversation: (id: string) => void
  // Supprime une conversation par son id (sans toucher aux shapes). Utilisé
  // par le dropdown historique quand l'utilisateur supprime une conv autre
  // que celle actuellement active dans la shape.
  deleteConversationById: (conversationId: string) => Promise<void>

  // Messages & streaming
  sendMessage: (
    conversationId: string,
    content: string,
    opts: {
      model: string
      temperature: number
      webSearchEnabled: boolean
      wikiToolsEnabled?: boolean
      thinkingEnabled?: boolean
      systemPrompt?: string | null
      wikiContext?: string | null
      maxTokens?: number
    }
  ) => Promise<void>
  cancelStream: (conversationId: string) => Promise<void>
  // Confirmation de tool destructif. Envoie la décision au main qui
  // réveille le await côté streamChat. Met à jour localement le
  // ToolTrace pour l'affichage inline.
  confirmToolCall: (conversationId: string, toolCallId: string, approved: boolean) => Promise<void>
}

const DEFAULT_API_KEY_STATUS: AIApiKeyStatusT = {
  openrouter: false,
  tavily: false,
  encryptionAvailable: false
}

const DEFAULT_DEFAULTS: AIDefaultsT = {
  model: 'anthropic/claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096
}

export const useChatStore = create<ChatStore>((set, get) => ({
  hydrated: false,
  apiKeyStatus: DEFAULT_API_KEY_STATUS,
  defaults: DEFAULT_DEFAULTS,
  models: [],
  modelsLoading: false,
  conversations: new Map(),
  allConversations: new Map(),
  activeStreams: new Map(),
  messageSegments: new Map(),

  hydrate: async () => {
    // Installe le listener de streaming UNE SEULE FOIS au premier hydrate.
    // Les chunks reçus sont routés par conversationId dans activeStreams.
    installChunkListener(set, get)

    const [status, defaults] = await Promise.all([
      window.blow.ai.getApiKeyStatus() as Promise<AIApiKeyStatusT>,
      window.blow.ai.getDefaults() as Promise<AIDefaultsT>
    ])
    set({ apiKeyStatus: status, defaults, hydrated: true })

    // Charge l'index complet des conversations (métadata seulement) pour
    // alimenter le dropdown historique de chaque ChatShape. Pas bloquant —
    // si la DB n'a encore aucune conv, la map reste vide.
    void get().refreshAllConversations()

    // Lazy-load des modèles : n'appelle OpenRouter que si la clé existe,
    // pour éviter un 401 bruyant au boot d'une instance fraîche.
    if (status.openrouter) {
      void get().refreshModels()
    }
  },

  refreshAllConversations: async () => {
    try {
      const list = (await window.blow.ai.listConversations()) as AIConversationSummaryT[]
      const map = new Map<string, AIConversationSummaryT>()
      for (const c of list) map.set(c.id, c)
      set({ allConversations: map })
    } catch (e) {
      console.warn('[chat-store] échec listConversations', e)
    }
  },

  refreshApiKeyStatus: async () => {
    const status = (await window.blow.ai.getApiKeyStatus()) as AIApiKeyStatusT
    set({ apiKeyStatus: status })
  },

  refreshModels: async (forceRefresh = false) => {
    set({ modelsLoading: true })
    try {
      const models = (await window.blow.ai.listModels({
        forceRefresh
      })) as AIModelT[]
      set({ models })
    } catch (e) {
      console.warn('[chat-store] échec listModels', e)
    } finally {
      set({ modelsLoading: false })
    }
  },

  refreshDefaults: async () => {
    const d = (await window.blow.ai.getDefaults()) as AIDefaultsT
    set({ defaults: d })
  },

  ensureConversation: async (id, opts) => {
    const existing = get().conversations.get(id)
    if (existing) return existing.conversation

    // Cherche côté DB d'abord (ChatShape restaurée d'un snapshot).
    const fetched = (await window.blow.ai.getConversation(id)) as {
      conversation: AIConversationT
      messages: AIMessageT[]
    } | null
    if (fetched) {
      const convs = new Map(get().conversations)
      convs.set(id, fetched)
      const allConvs = new Map(get().allConversations)
      allConvs.set(id, {
        ...fetched.conversation,
        messagesCount: fetched.messages.length
      })
      // Hydrate la Map des segments depuis la colonne DB. Rétablit les
      // timelines entrelacées persistées lors de précédents streams.
      const segmentsMap = hydrateSegmentsFromMessages(
        get().messageSegments,
        fetched.messages
      )
      set({ conversations: convs, allConversations: allConvs, messageSegments: segmentsMap })
      return fetched.conversation
    }

    // Sinon crée. Le main valide via Zod, retourne l'objet persisté.
    const conversation = (await window.blow.ai.createConversation({
      id,
      model: opts.model,
      system: opts.system ?? null,
      temperature: opts.temperature ?? 0.7,
      projectId: opts.projectId ?? null
    })) as AIConversationT
    const convs = new Map(get().conversations)
    convs.set(id, { conversation, messages: [] })
    const allConvs = new Map(get().allConversations)
    allConvs.set(id, { ...conversation, messagesCount: 0 })
    set({ conversations: convs, allConversations: allConvs })
    return conversation
  },

  loadConversation: async (id) => {
    const fetched = (await window.blow.ai.getConversation(id)) as {
      conversation: AIConversationT
      messages: AIMessageT[]
    } | null
    if (!fetched) return null
    const convs = new Map(get().conversations)
    convs.set(id, fetched)
    const segmentsMap = hydrateSegmentsFromMessages(get().messageSegments, fetched.messages)
    set({ conversations: convs, messageSegments: segmentsMap })
    return fetched
  },

  updateConversation: async (input) => {
    const updated = (await window.blow.ai.updateConversation(input)) as AIConversationT | null
    if (!updated) return
    const convs = new Map(get().conversations)
    const current = convs.get(input.id)
    if (current) {
      convs.set(input.id, { ...current, conversation: updated })
    }
    const allConvs = new Map(get().allConversations)
    const summary = allConvs.get(input.id)
    if (summary) {
      allConvs.set(input.id, { ...summary, ...updated })
    }
    set({ conversations: convs, allConversations: allConvs })
  },

  removeConversation: (id) => {
    const convs = new Map(get().conversations)
    convs.delete(id)
    const streams = new Map(get().activeStreams)
    streams.delete(id)
    const allConvs = new Map(get().allConversations)
    allConvs.delete(id)
    set({ conversations: convs, activeStreams: streams, allConversations: allConvs })
    // Hard-delete côté DB : best-effort, si ça échoue l'utilisateur
    // ne voit rien (la ChatShape a déjà disparu du canvas).
    void window.blow.ai.deleteConversation(id).catch(() => {})
  },

  deleteConversationById: async (conversationId) => {
    // Supprime côté DB et nettoie les caches locaux. Utilisé par le
    // dropdown historique quand l'utilisateur vire une conv non active.
    try {
      await window.blow.ai.deleteConversation(conversationId)
    } catch (e) {
      console.warn('[chat-store] échec deleteConversation', e)
      return
    }
    const convs = new Map(get().conversations)
    convs.delete(conversationId)
    const streams = new Map(get().activeStreams)
    streams.delete(conversationId)
    const allConvs = new Map(get().allConversations)
    allConvs.delete(conversationId)
    set({ conversations: convs, activeStreams: streams, allConversations: allConvs })
  },

  sendMessage: async (conversationId, content, opts) => {
    // Garde re-entrancy : un stream tourne déjà pour cette conversation.
    // Sans ce guard, un 2e appel pendant le 1er écraserait l'entrée
    // activeStreams → le renderer perd la trace du 1er (qui continue
    // pourtant côté main, d'où double facturation API). Le bouton Send
    // est déjà disabled côté ChatInput pendant isStreaming, mais ce
    // guard protège contre les appels programmatiques (raccourcis
    // clavier, tests, futurs handlers automatiques).
    if (get().activeStreams.has(conversationId)) {
      console.warn(
        `[chat-store] sendMessage ignoré : stream déjà actif pour ${conversationId}`
      )
      return
    }
    // Optimistic append du message user côté renderer AVANT l'IPC :
    // le textarea est déjà vide, l'utilisateur doit voir sa ligne dans
    // l'historique immédiatement. Le main va commit la même chose —
    // au prochain `loadConversation` on aura l'id réel côté DB.
    const convs = new Map(get().conversations)
    const current = convs.get(conversationId)
    if (current) {
      const optimisticUser: AIMessageT = {
        id: `optimistic-${Date.now()}`,
        conversationId,
        role: 'user',
        content,
        model: null,
        tokensIn: null,
        tokensOut: null,
        createdAt: Date.now()
      }
      convs.set(conversationId, {
        ...current,
        messages: [...current.messages, optimisticUser]
      })
      set({ conversations: convs })
    }

    const { requestId } = (await window.blow.ai.sendMessage({
      conversationId,
      content,
      model: opts.model,
      temperature: opts.temperature,
      systemPrompt: opts.systemPrompt ?? null,
      wikiContext: opts.wikiContext ?? null,
      webSearchEnabled: opts.webSearchEnabled,
      wikiToolsEnabled: opts.wikiToolsEnabled ?? false,
      thinkingEnabled: opts.thinkingEnabled ?? false,
      maxTokens: opts.maxTokens
    })) as { requestId: string }

    const streams = new Map(get().activeStreams)
    streams.set(conversationId, {
      requestId,
      segments: [],
      startedAt: Date.now(),
      awaitingConfirm: null
    })
    set({ activeStreams: streams })
  },

  cancelStream: async (conversationId) => {
    const stream = get().activeStreams.get(conversationId)
    if (!stream) return
    await window.blow.ai.cancelStream(stream.requestId)
    // Le listener chunk `done` nettoiera activeStreams à la réception
    // du broadcast de fin — pas besoin de le faire ici.
  },

  confirmToolCall: async (conversationId, toolCallId, approved) => {
    // Update optimiste : on sort la demande "awaitingConfirm" et on
    // passe le segment 'tool' correspondant en status = en cours / refusé.
    const streams = new Map(get().activeStreams)
    const stream = streams.get(conversationId)
    if (stream) {
      const segments: Segment[] = stream.segments.map((s) => {
        if (s.kind !== 'tool' || s.trace.id !== toolCallId) return s
        return {
          kind: 'tool',
          trace: {
            ...s.trace,
            status: approved ? ('running' as const) : ('refused' as const)
          }
        }
      })
      streams.set(conversationId, {
        ...stream,
        awaitingConfirm: null,
        segments
      })
      set({ activeStreams: streams })
    }
    try {
      await window.blow.ai.confirmToolCall(toolCallId, approved)
    } catch (e) {
      console.warn('[chat-store] confirmToolCall failed', e)
    }
  }
}))

// ──────────────────────────────────────────────────────────── Chunk listener

let chunkListenerInstalled = false

// Installe l'écouteur global sur `window.blow.ai.onChunk` UNE SEULE FOIS.
// Les deltas sont accumulés dans `activeStreams[convId]`, et au `done: true`
// on refetch la conversation depuis la DB pour récupérer le message
// assistant final (avec id stable, tokens, citations).
function installChunkListener(
  _set: unknown,
  _get: unknown
): void {
  if (chunkListenerInstalled) return
  chunkListenerInstalled = true

  // Helper partagé : applique un patch à l'entrée active du stream et
  // persiste dans le store. Retourne le segments[] résultant pour que
  // les handlers qui en ont besoin puissent chaîner (ex: toolConfirmNeeded
  // qui met aussi à jour awaitingConfirm).
  function patchStream(
    conversationId: string,
    patch: (prev: StreamState) => StreamState
  ): void {
    const streams = new Map(useChatStore.getState().activeStreams)
    const current = streams.get(conversationId)
    if (!current) return
    streams.set(conversationId, patch(current))
    useChatStore.setState({ activeStreams: streams })
  }

  window.blow.ai.onChunk((payload) => {
    const { conversationId, delta, reasoningDelta, done, error, citations, toolCall, toolResult, toolConfirmNeeded } = payload

    // Timeline entrelacée : un delta texte prolonge le dernier segment
    // 'text', un toolCall crée un nouveau segment 'tool', un reasoningDelta
    // prolonge le dernier segment 'reasoning' (s'il n'est pas encore done).
    // L'ordre de réception des chunks est chronologique → les segments
    // reflètent le déroulé exact du modèle (reasoning → texte → action →
    // texte → action → réponse finale).
    //
    // Règle de fermeture : dès qu'un texte ou un tool arrive, on clôt le
    // reasoning en cours (closeOpenReasoning) pour que l'UI arrête la
    // shimmer et puisse replier le bloc.
    if (reasoningDelta) {
      patchStream(conversationId, (prev) => ({
        ...prev,
        segments: appendReasoningDelta(prev.segments, reasoningDelta)
      }))
    }

    if (delta) {
      patchStream(conversationId, (prev) => ({
        ...prev,
        segments: appendTextDelta(closeOpenReasoning(prev.segments), delta)
      }))
    }

    if (toolCall) {
      patchStream(conversationId, (prev) => {
        const closed = closeOpenReasoning(prev.segments)
        const existing = closed.find(
          (s): s is Extract<Segment, { kind: 'tool' }> =>
            s.kind === 'tool' && s.trace.id === toolCall.id
        )
        const trace: ToolTrace = existing
          ? { ...existing.trace, arguments: toolCall.arguments, status: 'running' }
          : {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
              status: 'running'
            }
        return { ...prev, segments: upsertToolSegment(closed, trace) }
      })
    }

    if (toolConfirmNeeded) {
      patchStream(conversationId, (prev) => {
        const existing = prev.segments.find(
          (s): s is Extract<Segment, { kind: 'tool' }> =>
            s.kind === 'tool' && s.trace.id === toolConfirmNeeded.id
        )
        const trace: ToolTrace = existing
          ? { ...existing.trace, arguments: toolConfirmNeeded.arguments, status: 'awaiting-confirm' }
          : {
              id: toolConfirmNeeded.id,
              name: toolConfirmNeeded.name,
              arguments: toolConfirmNeeded.arguments,
              status: 'awaiting-confirm'
            }
        return {
          ...prev,
          segments: upsertToolSegment(prev.segments, trace),
          awaitingConfirm: {
            id: toolConfirmNeeded.id,
            name: toolConfirmNeeded.name,
            arguments: toolConfirmNeeded.arguments
          }
        }
      })
    }

    if (toolResult) {
      patchStream(conversationId, (prev) => {
        const existing = prev.segments.find(
          (s): s is Extract<Segment, { kind: 'tool' }> =>
            s.kind === 'tool' && s.trace.id === toolResult.id
        )
        if (!existing) return prev
        const trace: ToolTrace = {
          ...existing.trace,
          status: toolResult.error ? 'error' : 'success',
          result: toolResult.result,
          error: toolResult.error
        }
        return { ...prev, segments: upsertToolSegment(prev.segments, trace) }
      })
    }

    if (done) {
      const streams = new Map(useChatStore.getState().activeStreams)
      const current = streams.get(conversationId)
      // Capture les segments AVANT le delete. Tout reasoning encore
      // ouvert est forcé à done:true — la réponse est finie, la shimmer
      // doit s'arrêter même si le modèle n'a pas envoyé de texte après
      // le reasoning (cas rare mais possible).
      const finalSegments = current ? closeOpenReasoning(current.segments) : []
      if (current && error) {
        streams.set(conversationId, { ...current, segments: finalSegments, error, citations })
        useChatStore.setState({ activeStreams: streams })
      }
      void (async () => {
        const fetched = (await window.blow.ai.getConversation(conversationId)) as {
          conversation: AIConversationT
          messages: AIMessageT[]
        } | null
        const convs = new Map(useChatStore.getState().conversations)
        if (fetched) convs.set(conversationId, fetched)
        const newStreams = new Map(useChatStore.getState().activeStreams)
        newStreams.delete(conversationId)
        // Met à jour l'index dropdown avec le nouveau count/updatedAt/title.
        const allConvs = new Map(useChatStore.getState().allConversations)
        if (fetched) {
          allConvs.set(conversationId, {
            ...fetched.conversation,
            messagesCount: fetched.messages.length
          })
        }
        // Hydrate d'abord les segments persistés en DB (messages passés
        // de cette conversation qui auraient déjà des timelines).
        let segmentsMap = fetched
          ? hydrateSegmentsFromMessages(
              useChatStore.getState().messageSegments,
              fetched.messages
            )
          : new Map(useChatStore.getState().messageSegments)

        // Attache la timeline capturée au dernier message assistant pour
        // qu'elle reste visible après la fin du stream. On la persiste
        // aussi en DB via `ai.saveMessageSegments` → l'historique est
        // conservé après un reload de l'app. On ne persiste que les
        // timelines qui ont au moins un segment tool OU reasoning —
        // sinon le message est purement textuel et son content suffit.
        const hasToolSegment = finalSegments.some(
          (s) => s.kind === 'tool' || s.kind === 'reasoning'
        )
        if (fetched && hasToolSegment) {
          const lastAssistant = [...fetched.messages]
            .reverse()
            .find((m) => m.role === 'assistant')
          if (lastAssistant) {
            segmentsMap = new Map(segmentsMap)
            segmentsMap.set(lastAssistant.id, finalSegments)
            // Fire-and-forget : la persistance DB peut prendre quelques ms,
            // pas besoin de bloquer l'UI. Si ça échoue, on log mais la
            // copie mémoire reste valide pour la session courante.
            void window.blow.ai
              .saveMessageSegments(lastAssistant.id, JSON.stringify(finalSegments))
              .catch((e: unknown) => {
                console.warn('[chat-store] persist segments failed', e)
              })
          }
        }
        useChatStore.setState({
          conversations: convs,
          activeStreams: newStreams,
          allConversations: allConvs,
          messageSegments: segmentsMap
        })
      })().catch((e) => {
        console.warn('[chat-store] refetch conversation failed', e)
      })
    }
  })
}
