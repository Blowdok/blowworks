import { nanoid } from 'nanoid'
import { getDb } from './db.js'
import { listMessages, getConversation } from './ai-conversations.js'
import { oneShotChat } from './openrouter.js'
import * as wiki from './wiki-fs.js'
import type {
  AgentT,
  AgentKindT,
  AgentCreateInputT,
  AgentUpdateInputT,
  AgentSynthesizerResultT,
  AgentWikiBuilderResultT,
  AgentWikiBuilderOperationT
} from '@shared/ipc-contract.js'

// Gestionnaire d'agents IA (lot 3). Deux agents système sont seedés dans
// `db.ts` au 1er boot. Les agents `custom` sont créés par l'utilisateur
// depuis Settings > Agents. Les runners (`runSynthesizer`, `runWikiBuilder`)
// orchestrent la chaîne lecture-DB → prompt → OpenRouter → écriture-FS.

// ──────────────────────────────────────────────────────────── CRUD

interface AgentRow {
  id: string
  kind: string
  name: string
  description: string
  model: string
  system_prompt: string
  enabled: number
  created_at: number
  updated_at: number
}

function rowToAgent(row: AgentRow): AgentT {
  return {
    id: row.id,
    kind: row.kind as AgentKindT,
    name: row.name,
    description: row.description,
    model: row.model,
    systemPrompt: row.system_prompt,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listAgents(): AgentT[] {
  const rows = getDb()
    .prepare('SELECT * FROM agents ORDER BY kind ASC, name ASC')
    .all() as AgentRow[]
  return rows.map(rowToAgent)
}

export function getAgent(id: string): AgentT | null {
  const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as
    | AgentRow
    | undefined
  return row ? rowToAgent(row) : null
}

function getAgentByKind(kind: AgentKindT): AgentT | null {
  const row = getDb()
    .prepare('SELECT * FROM agents WHERE kind = ? LIMIT 1')
    .get(kind) as AgentRow | undefined
  return row ? rowToAgent(row) : null
}

export function createAgent(input: AgentCreateInputT): AgentT {
  const now = Date.now()
  const id = `agent.custom.${nanoid(10)}`
  getDb()
    .prepare(
      `INSERT INTO agents (id, kind, name, description, model, system_prompt,
                           enabled, created_at, updated_at)
       VALUES (?, 'custom', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.description ?? '',
      input.model,
      input.systemPrompt,
      input.enabled === false ? 0 : 1,
      now,
      now
    )
  return getAgent(id)!
}

export function updateAgent(input: AgentUpdateInputT): AgentT | null {
  const existing = getAgent(input.id)
  if (!existing) return null

  const next: AgentT = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    model: input.model ?? existing.model,
    systemPrompt: input.systemPrompt ?? existing.systemPrompt,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: Date.now()
  }

  getDb()
    .prepare(
      `UPDATE agents
         SET name = ?, description = ?, model = ?, system_prompt = ?,
             enabled = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.name,
      next.description,
      next.model,
      next.systemPrompt,
      next.enabled ? 1 : 0,
      next.updatedAt,
      next.id
    )
  return next
}

// Suppression autorisée UNIQUEMENT sur les agents `custom`. Les agents
// système sont protégés — l'utilisateur peut seulement les désactiver.
export function deleteAgent(id: string): { ok: boolean; reason?: string } {
  const existing = getAgent(id)
  if (!existing) return { ok: false, reason: 'Agent introuvable.' }
  if (existing.kind !== 'custom') {
    return {
      ok: false,
      reason: 'Agent système non supprimable. Utilisez le toggle « activé » pour le désactiver.'
    }
  }
  getDb().prepare('DELETE FROM agents WHERE id = ?').run(id)
  return { ok: true }
}

// ──────────────────────────────────────────────────────────── Runners

// Slugifie un timestamp + uuid court en nom de fichier sûr pour le FS.
// Forme : `conv-<8 derniers chars de convId>-2026-04-23T15-22-07.md`.
function buildRawFilename(conversationId: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const tail = conversationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8)
  return `conv-${tail}-${iso}.md`
}

export async function runSynthesizer(
  conversationId: string
): Promise<AgentSynthesizerResultT> {
  const agent = getAgentByKind('synthesizer')
  if (!agent) {
    throw new Error(
      "Agent Synthétiseur introuvable. La DB a-t-elle été correctement migrée ?"
    )
  }
  if (!agent.enabled) {
    throw new Error(
      "Agent Synthétiseur désactivé. Activez-le dans Paramètres > Agents."
    )
  }

  const conv = getConversation(conversationId)
  if (!conv) throw new Error(`Conversation ${conversationId} introuvable.`)

  const messages = listMessages(conversationId)
  if (messages.length === 0) {
    throw new Error('Conversation vide : rien à synthétiser.')
  }

  // Prompt user = retranscription simple de la conversation. Le model
  // reçoit le systemPrompt de l'agent + cette retranscription, et produit
  // la synthèse au format défini par le systemPrompt.
  const transcript = messages
    .map((m) => {
      const role = m.role === 'user' ? 'Utilisateur' : m.role === 'assistant' ? 'IA' : 'Système'
      return `### ${role}\n\n${m.content}`
    })
    .join('\n\n---\n\n')

  const userPrompt = `Titre courant de la conversation : ${conv.title || 'Sans titre'}\n\nConversation complète :\n\n${transcript}`

  const result = await oneShotChat({
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    userPrompt,
    temperature: 0.3, // température basse : on veut un résumé stable, pas créatif
    maxTokens: 2048
  })

  if (result.error) {
    throw new Error(`Échec Synthétiseur : ${result.error}`)
  }
  if (result.content.trim().length === 0) {
    throw new Error('Synthétiseur a retourné une réponse vide.')
  }

  const filename = buildRawFilename(conversationId)
  await wiki.writeRaw(filename, result.content)

  return { filename, summary: result.content }
}

export async function runWikiBuilder(): Promise<AgentWikiBuilderResultT> {
  const agent = getAgentByKind('wiki_builder')
  if (!agent) {
    throw new Error(
      "Agent Wiki Builder introuvable. La DB a-t-elle été correctement migrée ?"
    )
  }
  if (!agent.enabled) {
    throw new Error(
      "Agent Wiki Builder désactivé. Activez-le dans Paramètres > Agents."
    )
  }

  const rawEntries = await wiki.listRaw()
  if (rawEntries.length === 0) {
    throw new Error('Aucune synthèse raw/ à traiter. Lancez le Synthétiseur d’abord.')
  }

  // Charge le contenu complet des raw (source principale) + seulement les
  // titres des wiki existants (contexte de l'état courant, pas de payload
  // démesuré si le wiki devient gros).
  const rawBlocks = await Promise.all(
    rawEntries.map(async (e) => {
      const content = await wiki.readRaw(e.name)
      return `### raw/${e.name}\n\n${content}`
    })
  )

  const wikiEntries = await wiki.listWiki()
  const wikiList = wikiEntries.map((e) => `- ${e.name}`).join('\n') || '(vide)'

  const userPrompt = `Voici les synthèses brutes à traiter :\n\n${rawBlocks.join('\n\n---\n\n')}\n\nPages wiki existantes :\n${wikiList}\n\nProduis le JSON d'opérations.`

  const result = await oneShotChat({
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    userPrompt,
    temperature: 0.2,
    maxTokens: 8192
  })

  if (result.error) {
    throw new Error(`Échec Wiki Builder : ${result.error}`)
  }

  const operations = parseWikiBuilderResponse(result.content)
  const applied: AgentWikiBuilderOperationT[] = []
  for (const op of operations) {
    await wiki.writeWiki(op.filename, op.content)
    applied.push({ op: op.op, filename: op.filename, bytes: op.content.length })
  }
  return { operations: applied }
}

// Parse la réponse JSON du Wiki Builder. Les modèles ont tendance à
// encadrer leur JSON avec ```json ... ``` ou d'ajouter un commentaire —
// on extrait le 1er objet JSON valide de la réponse.
interface WikiBuilderOp {
  op: 'create' | 'update'
  filename: string
  content: string
}

function parseWikiBuilderResponse(raw: string): WikiBuilderOp[] {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) {
    throw new Error(
      "Réponse Wiki Builder invalide : aucun objet JSON détecté dans la sortie du modèle."
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Réponse Wiki Builder invalide : JSON malformé (${msg}).`)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { operations?: unknown }).operations)
  ) {
    throw new Error(
      "Réponse Wiki Builder invalide : champ `operations` manquant ou non-tableau."
    )
  }
  const opsRaw = (parsed as { operations: unknown[] }).operations
  const ops: WikiBuilderOp[] = []
  for (const o of opsRaw) {
    if (
      !o ||
      typeof o !== 'object' ||
      typeof (o as { op?: unknown }).op !== 'string' ||
      typeof (o as { filename?: unknown }).filename !== 'string' ||
      typeof (o as { content?: unknown }).content !== 'string'
    ) {
      continue
    }
    const op = (o as { op: string }).op
    if (op !== 'create' && op !== 'update') continue
    ops.push({
      op,
      filename: (o as { filename: string }).filename,
      content: (o as { content: string }).content
    })
  }
  return ops
}

// Extraction robuste d'un objet JSON depuis une chaîne : on cherche la 1ère
// accolade ouvrante `{` et on trace les paires jusqu'à l'accolade fermante
// matching. Ignore les accolades dans les strings (""). Évite de se
// contenter d'un simple regex qui échoue sur les JSON imbriqués.
function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === '\\') {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}
