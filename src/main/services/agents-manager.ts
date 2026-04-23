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

// Normalise un chemin relatif en retirant les prefix `wiki/`, `./wiki/`,
// `/wiki/` que le modèle colle parfois malgré le prompt. `writeWiki`
// ajoute déjà le prefix côté FS, donc laisser le modèle le mettre causait
// l'arborescence `<folder>/wiki/wiki/concepts/xxx.md`.
function stripWikiPrefix(filename: string): string {
  let s = filename.replace(/\\/g, '/').trim()
  if (s.startsWith('./')) s = s.slice(2)
  if (s.startsWith('/')) s = s.slice(1)
  if (s.startsWith('wiki/')) s = s.slice(5)
  return s
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

  // Sentinel FLUSH_OK : l'agent a jugé qu'il n'y avait rien à sauver.
  // On ne crée PAS de fichier raw/ et on retourne un nom spécial que la
  // UI peut détecter pour afficher "rien à synthétiser" proprement.
  const trimmed = result.content.trim()
  if (trimmed === 'FLUSH_OK' || trimmed.startsWith('FLUSH_OK\n') || trimmed.startsWith('FLUSH_OK ')) {
    await wiki.appendLog(
      `## [${new Date().toISOString()}] synthesize | FLUSH_OK (rien à sauver pour conv "${conv.title || conversationId}")\n`
    )
    return {
      filename: '',
      summary: 'FLUSH_OK — la conversation ne contenait rien qui vaille la mémoire long-terme.'
    }
  }

  const filename = buildRawFilename(conversationId)
  await wiki.writeRaw(filename, result.content)

  // Append log — permet à l'utilisateur de suivre l'activité mémoire
  // depuis log.md sans avoir à ouvrir chaque raw.
  const title = conv.title || 'sans titre'
  await wiki.appendLog(
    `## [${new Date().toISOString()}] synthesize | conv "${title}" → raw/${filename}\n`
  )

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

  // Input complet du compilateur (pattern claude-memory-compiler) :
  // SCHEMA.md (spec) + index.md (état maître) + TOUS les articles wiki
  // existants + TOUS les raw à compiler. L'agent a tout en contexte pour
  // éviter doublons et maintenir les wikilinks croisés.
  const [schema, indexContent, wikiEntries, rawBlocks] = await Promise.all([
    wiki.readSchema(),
    wiki.readIndex(),
    wiki.listWiki(),
    Promise.all(
      rawEntries.map(async (e) => {
        const content = await wiki.readRaw(e.name)
        return `### raw/${e.name}\n\n${content}`
      })
    )
  ])

  // Contenu INTÉGRAL de chaque article existant — oui, c'est coûteux en
  // tokens quand le wiki grossit, mais c'est ce qui permet à l'agent de
  // détecter les doublons et d'enrichir au lieu de dupliquer. À revoir
  // au Sprint 2 (tools function-calling : read_wiki_page à la demande).
  const existingArticles = await Promise.all(
    wikiEntries.map(async (e) => {
      try {
        const content = await wiki.readWiki(e.name)
        // Headers sans prefix `wiki/` pour ne pas inciter le modèle à
        // recopier ce prefix dans ses `filename` d'operations. Le nom
        // brut `concepts/pagemark.md` est DÉJÀ relatif au dossier wiki.
        return `### ${e.name}\n\n${content}`
      } catch {
        return null
      }
    })
  )
  const existingArticlesBlock = existingArticles.filter((x): x is string => x !== null).join('\n\n---\n\n') || '(aucun article existant)'

  const userPrompt = [
    '## Contexte du compilateur',
    '',
    '**IMPORTANT** : tous les `filename` que tu produis dans `operations[]` sont relatifs au dossier `wiki/`. Écris `concepts/pagemark.md`, PAS `wiki/concepts/pagemark.md`. Le runner ajoute le prefix automatiquement — si tu le mets aussi, tu créeras une arborescence `wiki/wiki/...`.',
    '',
    '### SCHEMA.md (spec)',
    schema ?? '(SCHEMA.md absent — utilise les conventions standard de BlowWorks)',
    '',
    '### index.md (état maître, vit dans wiki/index.md)',
    indexContent ?? '(index.md absent — à créer)',
    '',
    '### Articles existants (chemins relatifs à wiki/)',
    existingArticlesBlock,
    '',
    '## Raw sources à compiler',
    '',
    rawBlocks.join('\n\n---\n\n'),
    '',
    '## Tâche',
    "Produis le JSON d'opérations selon la spec SCHEMA. N'inline pas de markdown fence autour du JSON. Rappel : `filename` sans prefix `wiki/`."
  ].join('\n\n')

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

  const parsed = parseWikiBuilderResponse(result.content)
  const applied: AgentWikiBuilderOperationT[] = []

  for (const op of parsed.operations) {
    try {
      // Les modèles ajoutent parfois un prefix `wiki/` au filename malgré
      // le prompt qui dit que c'est relatif au dossier wiki/. Strip pour
      // éviter l'arborescence `wiki/wiki/concepts/xxx.md`. Robuste aux
      // variantes `./wiki/`, `/wiki/` et `wiki\\` (backslash Windows).
      const cleanFilename = stripWikiPrefix(op.filename)

      if (op.op === 'create' || op.op === 'update') {
        await wiki.writeWiki(cleanFilename, op.content)
      } else if (op.op === 'rename') {
        if (op.renameFrom) {
          await wiki.renameWiki(
            stripWikiPrefix(op.renameFrom),
            cleanFilename
          )
        } else {
          continue
        }
      }
      applied.push({ op: op.op, filename: cleanFilename, bytes: op.content.length })
    } catch (e) {
      console.warn(`[wiki-builder] op ${op.op} ${op.filename} échouée :`, e)
    }
  }

  // Met à jour index.md + log.md si fournis par l'agent. Ces 2 écritures
  // ne peuvent pas être laissées à l'agent lui-même via operations[] car
  // elles portent une sémantique différente (maintenance vs article).
  if (parsed.indexUpdate && parsed.indexUpdate.trim().length > 0) {
    try {
      await wiki.writeIndex(parsed.indexUpdate)
    } catch (e) {
      console.warn('[wiki-builder] writeIndex échoué :', e)
    }
  }
  if (parsed.logEntry && parsed.logEntry.trim().length > 0) {
    // L'agent fournit la ligne préformattée. On ajoute un newline final
    // si manquant pour garantir l'append propre.
    const entry = parsed.logEntry.endsWith('\n') ? parsed.logEntry : parsed.logEntry + '\n'
    try {
      await wiki.appendLog(entry)
    } catch (e) {
      console.warn('[wiki-builder] appendLog échoué :', e)
    }
  }

  return { operations: applied }
}

// Parse la réponse JSON du Wiki Builder v2. Structure attendue :
//   { operations: [{op, filename, content, renameFrom?}], indexUpdate, logEntry }
// Les modèles encadrent souvent le JSON avec ```json ... ``` ou ajoutent
// un préambule — on extrait le 1er objet JSON valide.
interface WikiBuilderOp {
  op: 'create' | 'update' | 'rename'
  filename: string
  content: string
  renameFrom?: string
}

interface WikiBuilderParsedResponse {
  operations: WikiBuilderOp[]
  indexUpdate: string
  logEntry: string
}

function parseWikiBuilderResponse(raw: string): WikiBuilderParsedResponse {
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
  const obj = parsed as {
    operations: unknown[]
    indexUpdate?: unknown
    logEntry?: unknown
  }
  const ops: WikiBuilderOp[] = []
  for (const o of obj.operations) {
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
    if (op !== 'create' && op !== 'update' && op !== 'rename') continue
    const renameFromRaw = (o as { renameFrom?: unknown }).renameFrom
    ops.push({
      op: op as WikiBuilderOp['op'],
      filename: (o as { filename: string }).filename,
      content: (o as { content: string }).content,
      renameFrom: typeof renameFromRaw === 'string' ? renameFromRaw : undefined
    })
  }
  return {
    operations: ops,
    indexUpdate: typeof obj.indexUpdate === 'string' ? obj.indexUpdate : '',
    logEntry: typeof obj.logEntry === 'string' ? obj.logEntry : ''
  }
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
