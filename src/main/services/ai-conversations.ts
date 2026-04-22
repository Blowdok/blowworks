import { getDb } from './db.js'
import type {
  AIConversationT,
  AIMessageT,
  AIRoleT,
  AICreateConversationInputT,
  AIUpdateConversationInputT
} from '@shared/ipc-contract.js'

// Couche CRUD synchrone au-dessus de SQLite pour les conversations et
// messages IA. Pas d'async : better-sqlite3 est synchrone et le main
// process n'a pas de boucle d'événements à protéger d'un appel DB bref.
//
// Règles :
// - La conversation est créée PAR LE RENDERER au spawn d'une ChatShape
//   (id = shape.id) → `createConversation`.
// - Les messages sont append-only ; pas de modification post-insertion.
// - Au `deleteConversation`, les messages partent en cascade (FK SQLite).
// - Le titre auto-généré du 1er message est posté par `updateConversation`
//   depuis l'IPC handler quand le 1er chunk user est commité.

// ──────────────────────────────────────────────────────────── Conversations

interface ConversationRow {
  id: string
  title: string
  model: string
  system: string | null
  temperature: number
  project_id: string | null
  created_at: number
  updated_at: number
}

function rowToConversation(row: ConversationRow): AIConversationT {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    system: row.system,
    temperature: row.temperature,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createConversation(input: AICreateConversationInputT): AIConversationT {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO ai_conversations
         (id, title, model, system, temperature, project_id, created_at, updated_at)
       VALUES (?, '', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.model,
      input.system ?? null,
      input.temperature ?? 0.7,
      input.projectId ?? null,
      now,
      now
    )
  return getConversation(input.id)!
}

export function getConversation(id: string): AIConversationT | null {
  const row = getDb()
    .prepare('SELECT * FROM ai_conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined
  return row ? rowToConversation(row) : null
}

export function listConversations(): AIConversationT[] {
  const rows = getDb()
    .prepare('SELECT * FROM ai_conversations ORDER BY updated_at DESC')
    .all() as ConversationRow[]
  return rows.map(rowToConversation)
}

// Mise à jour partielle : seuls les champs fournis sont touchés. `updated_at`
// est toujours bumpé côté serveur — pas confiance au renderer pour l'horloge.
export function updateConversation(input: AIUpdateConversationInputT): AIConversationT | null {
  const existing = getConversation(input.id)
  if (!existing) return null

  const next: AIConversationT = {
    ...existing,
    title: input.title ?? existing.title,
    model: input.model ?? existing.model,
    system: input.system === undefined ? existing.system : input.system,
    temperature: input.temperature ?? existing.temperature,
    projectId: input.projectId === undefined ? existing.projectId : input.projectId,
    updatedAt: Date.now()
  }

  getDb()
    .prepare(
      `UPDATE ai_conversations
         SET title = ?, model = ?, system = ?, temperature = ?,
             project_id = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.title,
      next.model,
      next.system,
      next.temperature,
      next.projectId,
      next.updatedAt,
      next.id
    )
  return next
}

export function deleteConversation(id: string): void {
  // CASCADE côté SQL supprime les messages automatiquement (FK ON DELETE
  // CASCADE sur `ai_messages.conversation_id`). Rien à faire ici de plus.
  getDb().prepare('DELETE FROM ai_conversations WHERE id = ?').run(id)
}

// ──────────────────────────────────────────────────────────── Messages

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  created_at: number
}

function rowToMessage(row: MessageRow): AIMessageT {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as AIRoleT,
    content: row.content,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at
  }
}

export interface AppendMessageInput {
  id: string
  conversationId: string
  role: AIRoleT
  content: string
  model?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
}

export function appendMessage(input: AppendMessageInput): AIMessageT {
  const createdAt = Date.now()
  getDb()
    .prepare(
      `INSERT INTO ai_messages
         (id, conversation_id, role, content, model, tokens_in, tokens_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.conversationId,
      input.role,
      input.content,
      input.model ?? null,
      input.tokensIn ?? null,
      input.tokensOut ?? null,
      createdAt
    )
  // Bump `updated_at` de la conversation → fait remonter la conv dans la
  // liste ordonnée par activité (useful pour un futur panneau "historique").
  getDb()
    .prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?')
    .run(createdAt, input.conversationId)
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    model: input.model ?? null,
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    createdAt
  }
}

export function listMessages(conversationId: string): AIMessageT[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC'
    )
    .all(conversationId) as MessageRow[]
  return rows.map(rowToMessage)
}

// Utilitaire : génère un titre court (max 60 car) à partir du 1er message
// user. On tronque sur un mot entier si possible, sinon bête coupe dure.
// Appelé par l'IPC handler après le tout 1er message user d'une conv.
export function generateTitleFromFirstMessage(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 60) return trimmed
  const cut = trimmed.slice(0, 60)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…'
}
