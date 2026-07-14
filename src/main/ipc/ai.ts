import { ipcMain, BrowserWindow, safeStorage } from 'electron'
import { nanoid } from 'nanoid'
import {
  IPC_CHANNELS,
  AISendMessageInput,
  AICreateConversationInput,
  AIUpdateConversationInput,
  AISetApiKeyInput,
  AIConfirmToolCallInput,
  AIDefaultsSchema,
  AIOptimizePromptInput,
  type AIChunkEventT,
  type AIApiKeyStatusT,
  type AIDefaultsT
} from '@shared/ipc-contract.js'
import { resolveToolConfirmation } from '../services/ai-tool-confirmation.js'
import { buildUserMessageContent, parseAttachmentsJson } from '@shared/ai-attachments.js'
import type { ChatCompletionMessage } from '../services/openrouter.js'
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  appendMessage,
  listMessages,
  updateMessageSegments,
  generateTitleFromFirstMessage
} from '../services/ai-conversations.js'
import * as OpenRouter from '../services/openrouter.js'
import * as Tavily from '../services/tavily.js'
import { optimizePrompt } from '../services/prompt-optimizer.js'
import { z } from 'zod'

// Handlers IPC pour l'IA : conversations, messages, streaming, clés API.
// Côté streaming, on utilise le pattern `terminal.dataEvent` — un canal
// `ai.chunk` reçoit tous les chunks, le renderer route par `requestId`
// et `conversationId` contenus dans le payload.

// Récupère toutes les fenêtres ouvertes pour broadcast d'un chunk. En
// pratique BlowWorks n'a qu'une fenêtre, mais on couvre le cas multi.
function broadcastChunk(chunk: AIChunkEventT): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(IPC_CHANNELS.ai.chunkEvent, chunk)
  }
}

export function registerAIHandlers(): void {
  // ── Clés API ────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.ai.setApiKey, (_evt, raw): AIApiKeyStatusT => {
    const { provider, key } = AISetApiKeyInput.parse(raw)
    if (provider === 'openrouter') {
      OpenRouter.setOpenRouterKey(key)
    } else {
      Tavily.setTavilyKey(key)
    }
    return {
      openrouter: OpenRouter.hasOpenRouterKey(),
      tavily: Tavily.hasTavilyKey(),
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    }
  })

  ipcMain.handle(IPC_CHANNELS.ai.getApiKeyStatus, (): AIApiKeyStatusT => {
    return {
      openrouter: OpenRouter.hasOpenRouterKey(),
      tavily: Tavily.hasTavilyKey(),
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    }
  })

  // ── Défauts globaux (modèle, temp, maxTokens) ──────────────────────
  ipcMain.handle(IPC_CHANNELS.ai.getDefaults, (): AIDefaultsT => {
    return OpenRouter.getDefaults()
  })

  ipcMain.handle(IPC_CHANNELS.ai.setDefaults, (_evt, raw): AIDefaultsT => {
    const parsed = AIDefaultsSchema.parse(raw)
    OpenRouter.setDefaults(parsed)
    return parsed
  })

  // ── Modèles ─────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.ai.listModels, async (_evt, raw) => {
    const opts = z
      .object({ forceRefresh: z.boolean().optional() })
      .optional()
      .parse(raw)
    return OpenRouter.listModels(opts)
  })

  // ── Conversations CRUD ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.ai.createConversation, (_evt, raw) => {
    const input = AICreateConversationInput.parse(raw)
    return createConversation(input)
  })

  ipcMain.handle(IPC_CHANNELS.ai.updateConversation, (_evt, raw) => {
    const input = AIUpdateConversationInput.parse(raw)
    return updateConversation(input)
  })

  ipcMain.handle(IPC_CHANNELS.ai.getConversation, (_evt, raw) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(raw)
    const conv = getConversation(id)
    if (!conv) return null
    return {
      conversation: conv,
      messages: listMessages(id)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ai.listConversations, () => {
    return listConversations()
  })

  ipcMain.handle(IPC_CHANNELS.ai.deleteConversation, (_evt, raw) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(raw)
    deleteConversation(id)
    return { ok: true }
  })

  // ── Envoi d'un message + streaming ──────────────────────────────────
  //
  // Flux :
  //   1. Valide l'input (Zod) → throw si clé OpenRouter absente plus bas
  //   2. Commit le message user en DB immédiatement (visible dans la UI)
  //   3. Si c'est le 1er message de la conv, génère un titre auto
  //   4. Lance le stream (await non-bloquant, on retourne requestId)
  //   5. Chaque delta → broadcast `ai.chunk` au renderer
  //   6. Sur `done: true` → commit le message assistant en DB
  //   7. Sur erreur → commit quand même le partial si non-vide + error
  ipcMain.handle(IPC_CHANNELS.ai.sendMessage, async (_evt, raw) => {
    const input = AISendMessageInput.parse(raw)
    const conv = getConversation(input.conversationId)
    if (!conv) {
      throw new Error(
        `Conversation ${input.conversationId} introuvable. La ChatShape doit créer sa conversation avant d'envoyer un message.`
      )
    }

    // Historique actuel avant ajout du message user courant.
    const priorMessages = listMessages(input.conversationId)

    // Commit message user (bumpe updated_at de la conv).
    const attachments = input.attachments ?? []

    appendMessage({
      id: nanoid(),
      conversationId: input.conversationId,
      role: 'user',
      content: input.content,
      attachments: attachments.length > 0 ? attachments : null
    })

    const titleSeed =
      input.content.trim() ||
      (attachments[0]
        ? attachments[0].type === 'text'
          ? `Fichier : ${attachments[0].name}`
          : `Image : ${attachments[0].name}`
        : 'Message avec pièce jointe')

    if (conv.title.length === 0 && priorMessages.length === 0) {
      updateConversation({
        id: input.conversationId,
        title: generateTitleFromFirstMessage(titleSeed)
      })
    }

    const historyForModel: ChatCompletionMessage[] = [
      ...priorMessages.map((m) => {
        if (m.role === 'user' && m.attachmentsJson) {
          const atts = parseAttachmentsJson(m.attachmentsJson)
          if (atts.length > 0) {
            return {
              role: 'user' as const,
              content: buildUserMessageContent(m.content, atts)
            }
          }
        }
        return { role: m.role as 'user' | 'assistant' | 'system', content: m.content }
      }),
      {
        role: 'user' as const,
        content:
          attachments.length > 0
            ? buildUserMessageContent(input.content, attachments)
            : input.content
      }
    ]

    const requestId = nanoid()

    // Le stream tourne en tâche de fond — on retourne requestId tout de
    // suite pour que le renderer affiche l'état "generating" sans attendre.
    void (async () => {
      let assembled = ''
      let finalUsage: { promptTokens: number; completionTokens: number } | undefined
      let finalCitations: string[] | undefined
      let streamError: string | null = null

      await OpenRouter.streamChat(
        {
          requestId,
          model: input.model,
          messages: historyForModel,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          systemPrompt: input.systemPrompt ?? conv.system ?? undefined,
          wikiContext: input.wikiContext ?? undefined,
          webSearchEnabled: input.webSearchEnabled,
          webSearchQuery: input.content.trim() || titleSeed,
          wikiToolsEnabled: input.wikiToolsEnabled,
          thinkingEnabled: input.thinkingEnabled
        },
        (chunk) => {
          if (chunk.delta) {
            assembled += chunk.delta
            broadcastChunk({
              requestId,
              conversationId: input.conversationId,
              delta: chunk.delta
            })
          }
          if (chunk.reasoningDelta) {
            broadcastChunk({
              requestId,
              conversationId: input.conversationId,
              reasoningDelta: chunk.reasoningDelta
            })
          }
          if (chunk.error) {
            streamError = chunk.error
          }
          if (chunk.usage) {
            finalUsage = chunk.usage
          }
          if (chunk.citations) {
            finalCitations = chunk.citations
          }
          // Tool events (Sprint 2). Forwardés tels quels au renderer.
          // Pour `toolCall`/`toolResult`, le renderer affiche inline dans
          // le streaming bubble. Pour `toolConfirmNeeded`, il ouvre un
          // dialog et attend la décision utilisateur (qui revient via
          // le canal `ai.confirmToolCall`).
          if (chunk.toolCall) {
            broadcastChunk({
              requestId,
              conversationId: input.conversationId,
              toolCall: chunk.toolCall
            })
          }
          if (chunk.toolResult) {
            broadcastChunk({
              requestId,
              conversationId: input.conversationId,
              toolResult: chunk.toolResult
            })
          }
          if (chunk.toolConfirmNeeded) {
            broadcastChunk({
              requestId,
              conversationId: input.conversationId,
              toolConfirmNeeded: chunk.toolConfirmNeeded
            })
          }
          if (chunk.done) {
            // Commit le message assistant final AVANT d'émettre le `done`
            // côté renderer — garantit que quand la UI rafraîchit depuis
            // la DB, tout est déjà persisté.
            if (assembled.length > 0 || streamError) {
              appendMessage({
                id: nanoid(),
                conversationId: input.conversationId,
                role: 'assistant',
                content: assembled + (streamError ? `\n\n_Erreur : ${streamError}_` : ''),
                model: input.model,
                tokensIn: finalUsage?.promptTokens ?? null,
                tokensOut: finalUsage?.completionTokens ?? null
              })
            }
            broadcastChunk({
              requestId,
              conversationId: input.conversationId,
              done: true,
              usage: finalUsage,
              citations: finalCitations,
              error: streamError ?? undefined
            })
          }
        }
      )
    })().catch((e) => {
      // Garde-fou : si `streamChat` throw (ce qu'il ne devrait pas, il
      // catch tout en interne), on broadcast un done/error propre.
      const msg = e instanceof Error ? e.message : String(e)
      broadcastChunk({
        requestId,
        conversationId: input.conversationId,
        done: true,
        error: msg
      })
    })

    return { requestId }
  })

  ipcMain.handle(IPC_CHANNELS.ai.cancelStream, (_evt, raw) => {
    const { requestId } = z.object({ requestId: z.string().min(1) }).parse(raw)
    const ok = OpenRouter.cancelStream(requestId)
    return { ok }
  })

  // Confirmation d'un tool destructif (Sprint 2). Le renderer appelle ce
  // canal quand l'utilisateur clique Approuver/Refuser dans le dialog.
  // Le await côté streamChat se débloque et la boucle agent continue.
  ipcMain.handle(IPC_CHANNELS.ai.confirmToolCall, (_evt, raw) => {
    const { toolCallId, approved } = AIConfirmToolCallInput.parse(raw)
    const ok = resolveToolConfirmation(toolCallId, approved)
    return { ok }
  })

  // Persiste la timeline entrelacée d'un message assistant (Sprint 5).
  // Appelé par le renderer au done du stream avec le JSON des segments.
  // `null` = efface la timeline (message purement textuel rétroactivement).
  ipcMain.handle(IPC_CHANNELS.ai.saveMessageSegments, (_evt, raw) => {
    const { messageId, segmentsJson } = z
      .object({
        messageId: z.string().min(1),
        segmentsJson: z.string().max(5_000_000).nullable()
      })
      .parse(raw)
    updateMessageSegments(messageId, segmentsJson)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.ai.optimizePrompt, async (_evt, raw) => {
    const { text } = AIOptimizePromptInput.parse(raw)
    return optimizePrompt(text)
  })
}
