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

export interface StreamState {
  requestId: string
  content: string
  startedAt: number
  citations?: string[]
  error?: string
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
    opts: { model: string; temperature: number; webSearchEnabled: boolean; systemPrompt?: string | null; maxTokens?: number }
  ) => Promise<void>
  cancelStream: (conversationId: string) => Promise<void>
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
      set({ conversations: convs, allConversations: allConvs })
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
    set({ conversations: convs })
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
      webSearchEnabled: opts.webSearchEnabled,
      maxTokens: opts.maxTokens
    })) as { requestId: string }

    const streams = new Map(get().activeStreams)
    streams.set(conversationId, {
      requestId,
      content: '',
      startedAt: Date.now()
    })
    set({ activeStreams: streams })
  },

  cancelStream: async (conversationId) => {
    const stream = get().activeStreams.get(conversationId)
    if (!stream) return
    await window.blow.ai.cancelStream(stream.requestId)
    // Le listener chunk `done` nettoiera activeStreams à la réception
    // du broadcast de fin — pas besoin de le faire ici.
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

  window.blow.ai.onChunk((payload) => {
    const { conversationId, delta, done, error, citations } = payload
    const state = useChatStore.getState()

    if (delta) {
      const streams = new Map(state.activeStreams)
      const current = streams.get(conversationId)
      if (current) {
        streams.set(conversationId, { ...current, content: current.content + delta })
        useChatStore.setState({ activeStreams: streams })
      }
    }

    if (done) {
      const streams = new Map(useChatStore.getState().activeStreams)
      const current = streams.get(conversationId)
      if (current && error) {
        streams.set(conversationId, { ...current, error, citations })
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
        useChatStore.setState({
          conversations: convs,
          activeStreams: newStreams,
          allConversations: allConvs
        })
      })().catch((e) => {
        console.warn('[chat-store] refetch conversation failed', e)
      })
    }
  })
}
