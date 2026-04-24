import { nanoid } from 'nanoid'
import { getDb } from './db.js'
import { listMessages, getConversation } from './ai-conversations.js'
import { oneShotChat } from './openrouter.js'
import * as wiki from './wiki-fs.js'
import { runWikiLint, findSafeFixableIssues, type LintReport, type LintIssue } from './wiki-lint.js'
import { researchAndUpdate, type ResearchResult } from './researcher.js'
import type {
  AgentT,
  AgentKindT,
  AgentCreateInputT,
  AgentUpdateInputT,
  AgentSynthesizerResultT,
  AgentWikiBuilderResultT,
  AgentWikiBuilderOperationT,
  WikiEntryT
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
  temperature: number
  max_tokens: number
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
    // Fallback 0.7 si une install antérieure a une ligne sans temperature
    // (cas impossible après la migration ALTER TABLE, mais ceinture +
    // bretelles contre un cache/corruption).
    temperature: typeof row.temperature === 'number' ? row.temperature : 0.7,
    maxTokens: typeof row.max_tokens === 'number' ? row.max_tokens : 4096,
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
                           temperature, max_tokens, enabled, created_at, updated_at)
       VALUES (?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.description ?? '',
      input.model,
      input.systemPrompt,
      input.temperature ?? 0.7,
      input.maxTokens ?? 4096,
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
    temperature: input.temperature ?? existing.temperature,
    maxTokens: input.maxTokens ?? existing.maxTokens,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: Date.now()
  }

  getDb()
    .prepare(
      `UPDATE agents
         SET name = ?, description = ?, model = ?, system_prompt = ?,
             temperature = ?, max_tokens = ?, enabled = ?,
             customized = 1, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.name,
      next.description,
      next.model,
      next.systemPrompt,
      next.temperature,
      next.maxTokens,
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

// Extrait un résumé court d'un article markdown : frontmatter YAML complet
// + 1er paragraphe du corps. Utilisé en mode compact quand le prompt full
// dépasse le budget — le WB garde assez de contexte pour détecter les
// doublons et respecter les conventions, sans inliner 50k tokens d'articles.
function extractArticleDigest(content: string): string {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const frontmatter = fmMatch ? fmMatch[0] : ''
  const body = fmMatch ? content.slice(fmMatch[0].length).trimStart() : content.trimStart()
  // Premier paragraphe non-vide (ou premier titre si le fichier commence par ##).
  const firstBlock = body.split(/\n\s*\n/).find((p) => p.trim().length > 0) ?? ''
  const truncated = firstBlock.length > 400 ? firstBlock.slice(0, 400) + '…' : firstBlock
  return frontmatter ? `${frontmatter}\n\n${truncated}` : truncated
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
    temperature: agent.temperature,
    maxTokens: agent.maxTokens
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

  const allRawEntries = await wiki.listRaw()
  if (allRawEntries.length === 0) {
    throw new Error('Aucune synthèse raw/ à traiter. Lancez le Synthétiseur d’abord.')
  }

  // Incremental build (Sprint 4) : on lit l'état de compilation et on
  // filtre les raw dont le hash SHA-256 est identique à la dernière
  // compilation. Divise les coûts API par 3-5 sur un gros wiki où
  // seul 1-2 fichier(s) ont changé depuis la dernière run. L'utilisateur
  // peut forcer une recompile complète en supprimant .compile-state.json.
  const state = await wiki.readCompileState()
  const rawWithHashes = await Promise.all(
    allRawEntries.map(async (entry) => {
      const content = await wiki.readRaw(entry.name)
      const hash = wiki.computeRawHash(content)
      return { entry, content, hash }
    })
  )
  const rawToCompile = rawWithHashes.filter(
    ({ entry, hash }) => state.ingested[entry.name]?.hash !== hash
  )

  if (rawToCompile.length === 0) {
    console.log('[wiki-builder] incremental : tous les raw ont déjà leur hash dans state, rien à faire')
    await wiki.appendLog(
      `## [${new Date().toISOString()}] wiki-build | no-op (${allRawEntries.length} raw inchangés)\n`
    )
    return { operations: [] }
  }
  console.log(
    `[wiki-builder] incremental : ${rawToCompile.length}/${allRawEntries.length} raw à compiler`
  )

  // Chunking : si on a plus de RAW_PER_BATCH raw (APRÈS filtrage
  // incremental), on traite par lots séquentiels. Évite que le modèle
  // dépasse maxTokens en essayant de tout produire d'un coup. Entre
  // chaque batch on refetch index + articles existants pour que le
  // contexte soit à jour (les pages créées au batch N apparaissent au
  // batch N+1 → évite les doublons).
  const RAW_PER_BATCH = 3
  const batches: Array<typeof rawToCompile> = []
  for (let i = 0; i < rawToCompile.length; i += RAW_PER_BATCH) {
    batches.push(rawToCompile.slice(i, i + RAW_PER_BATCH))
  }

  console.log(
    `[wiki-builder] ${rawToCompile.length} raw → ${batches.length} batch(s) de ${RAW_PER_BATCH} max`
  )

  const allApplied: AgentWikiBuilderOperationT[] = []
  const now = Date.now()
  for (const [i, batch] of batches.entries()) {
    console.log(`[wiki-builder] batch ${i + 1}/${batches.length} : ${batch.map((b) => b.entry.name).join(', ')}`)
    const applied = await runWikiBuilderBatch(
      agent,
      batch.map((b) => b.entry)
    )
    allApplied.push(...applied)
    // Mise à jour de l'état incremental APRÈS succès du batch.
    // En cas d'erreur partielle sur un batch, les batches précédents
    // restent marqués compilés — pas de double travail au retry.
    for (const { entry, hash } of batch) {
      state.ingested[entry.name] = { hash, compiledAt: now }
    }
    try {
      await wiki.writeCompileState(state)
    } catch (e) {
      console.warn('[wiki-builder] writeCompileState échoué :', e)
    }
  }

  return { operations: allApplied }
}

// Traite UN batch de raw via le Wiki Builder. Recharge à chaque appel
// l'état du wiki (schema, index, articles existants) pour que les
// batches suivants voient les pages créées par les précédents. Coûteux
// en tokens d'entrée mais c'est le prix de la cohérence inter-batches.
async function runWikiBuilderBatch(
  agent: AgentT,
  batch: WikiEntryT[]
): Promise<AgentWikiBuilderOperationT[]> {
  const [schema, indexContent, wikiEntries, rawBlocks] = await Promise.all([
    wiki.readSchema(),
    wiki.readIndex(),
    wiki.listWiki(),
    Promise.all(
      batch.map(async (e) => {
        const content = await wiki.readRaw(e.name)
        return `### raw/${e.name}\n\n${content}`
      })
    )
  ])

  // Contenu des articles existants : inliné INTÉGRALEMENT tant que le
  // prompt total reste sous `BUDGET_INPUT_TOKENS`. Au-delà on bascule en
  // mode compact (frontmatter + 1er paragraphe seulement) pour éviter le
  // HTTP 400 "max context length" d'OpenRouter. Le WB a alors moins de
  // contexte pour détecter les doublons ou enrichir précisément, mais la
  // compilation passe au lieu de planter. L'index.md reste inliné en entier
  // dans tous les cas — c'est la carte maître des articles existants.
  const existingArticlesFull = await Promise.all(
    wikiEntries.map(async (e) => {
      try {
        const content = await wiki.readWiki(e.name)
        return { name: e.name, content }
      } catch {
        return null
      }
    })
  )
  const validArticles = existingArticlesFull.filter(
    (x): x is { name: string; content: string } => x !== null
  )
  const fullArticlesBlock =
    validArticles.map((a) => `### ${a.name}\n\n${a.content}`).join('\n\n---\n\n') ||
    '(aucun article existant)'

  // Lint-fix léger intégré : on récupère les issues "safe" (broken-ref +
  // orphan-source) et on les passe au WB pour qu'il les corrige PENDANT
  // cette compilation. Gratuit et rapide — pas d'appel LLM ici, juste
  // un re-run des 2 checks déterministes de wiki-lint. Max 30 issues
  // injectées pour borner la taille du prompt ; le reste attend le run
  // suivant (WB converge vers 0 issue sur quelques compilations).
  const safeIssues = await findSafeFixableIssues().catch(() => [] as LintIssue[])
  const correctionsBlock = buildCorrectionsBlock(safeIssues)

  const buildPrompt = (articlesBlock: string, compact: boolean): string => {
    const parts = [
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
      compact
        ? '### Articles existants — APERÇU COMPACT (frontmatter + 1er paragraphe seulement, pour tenir dans le contexte)'
        : '### Articles existants (chemins relatifs à wiki/)',
      articlesBlock,
      '',
      '## Raw sources à compiler (CE batch uniquement)',
      '',
      rawBlocks.join('\n\n---\n\n')
    ]
    if (correctionsBlock) parts.push('', correctionsBlock)
    parts.push(
      '',
      '## Tâche',
      "Produis le JSON d'opérations selon la spec SCHEMA pour CES sources uniquement. N'inline pas de markdown fence autour du JSON. Rappel : `filename` sans prefix `wiki/`."
    )
    if (compact) {
      parts.push(
        '',
        "_Note : le contexte est en mode compact car le wiki est dense. Si tu as besoin du contenu complet d'un article existant pour le mettre à jour, produis un `update` avec le contenu que tu veux appliquer — tu ne peux pas relire le corps intégral ici._"
      )
    }
    return parts.join('\n\n')
  }

  // Budget input : on cible ~140k tokens d'input pour laisser 24k de sortie
  // sous le plafond 200k des modèles Claude. Approximation ~4 chars/token.
  // Si le prompt full dépasse, on bascule en compact (titre + frontmatter +
  // 1er paragraphe de chaque article existant).
  const BUDGET_INPUT_CHARS = 140_000 * 4
  let userPrompt = buildPrompt(fullArticlesBlock, false)
  if (userPrompt.length > BUDGET_INPUT_CHARS) {
    const compactArticlesBlock =
      validArticles.map((a) => `### ${a.name}\n\n${extractArticleDigest(a.content)}`).join('\n\n---\n\n') ||
      '(aucun article existant)'
    userPrompt = buildPrompt(compactArticlesBlock, true)
    console.log(
      `[wiki-builder] prompt full trop gros (${fullArticlesBlock.length} chars d'articles) → bascule en mode compact (${compactArticlesBlock.length} chars)`
    )
  }

  const result = await oneShotChat({
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    userPrompt,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens
  })

  if (result.error) {
    throw new Error(`Échec Wiki Builder : ${result.error}`)
  }

  console.log(
    `[wiki-builder] réponse brute (${result.content.length} chars) :\n${result.content.slice(0, 2000)}${result.content.length > 2000 ? '\n…[tronqué pour log]' : ''}`
  )

  const parsed = parseWikiBuilderResponse(result.content)
  const applied: AgentWikiBuilderOperationT[] = []

  for (const op of parsed.operations) {
    try {
      const cleanFilename = stripWikiPrefix(op.filename)
      if (op.op === 'create' || op.op === 'update') {
        await wiki.writeWiki(cleanFilename, op.content)
      } else if (op.op === 'rename') {
        if (op.renameFrom) {
          await wiki.renameWiki(stripWikiPrefix(op.renameFrom), cleanFilename)
        } else {
          continue
        }
      }
      applied.push({ op: op.op, filename: cleanFilename, bytes: op.content.length })
    } catch (e) {
      console.warn(`[wiki-builder] op ${op.op} ${op.filename} échouée :`, e)
    }
  }

  if (parsed.indexUpdate && parsed.indexUpdate.trim().length > 0) {
    try {
      await wiki.writeIndex(parsed.indexUpdate)
    } catch (e) {
      console.warn('[wiki-builder] writeIndex échoué :', e)
    }
  }
  if (parsed.logEntry && parsed.logEntry.trim().length > 0) {
    const entry = parsed.logEntry.endsWith('\n') ? parsed.logEntry : parsed.logEntry + '\n'
    try {
      await wiki.appendLog(entry)
    } catch (e) {
      console.warn('[wiki-builder] appendLog échoué :', e)
    }
  }

  return applied
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
  // Strip markdown fences avant de chercher l'objet JSON.
  const stripped = stripMarkdownCodeFence(raw)
  const jsonText = extractJsonObject(stripped)

  // Cas 1 : objet JSON complet trouvé → tente parse strict.
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText)
      return finalizeParsedResponse(parsed)
    } catch {
      // tombe dans la récupération tolérante ci-dessous
    }
  }

  // Cas 2 (récupération tolérante) : le JSON global est tronqué/cassé,
  // on essaie d'extraire les opérations VALIDES depuis le tableau
  // `operations: [...]` objet par objet. Permet de sauver un build
  // partiel au lieu de tout perdre quand le modèle dépasse maxTokens.
  const partialOps = extractPartialOperations(stripped)
  if (partialOps.length > 0) {
    console.warn(
      `[wiki-builder] récupération tolérante : ${partialOps.length} opération(s) valide(s) extraites d'un JSON tronqué`
    )
    // indexUpdate et logEntry souvent perdus → on les laisse vides, le
    // runner garde son ancien index et écrit un log par défaut.
    return {
      operations: partialOps,
      indexUpdate: '',
      logEntry: `## [${new Date().toISOString()}] wiki-build | partiel : ${partialOps.length} ops sauvées d'un JSON tronqué`
    }
  }

  // Cas 3 : on n'a vraiment rien pu sauver. Diagnostic détaillé.
  const opens = (stripped.match(/\{/g) ?? []).length
  const closes = (stripped.match(/\}/g) ?? []).length
  const head = stripped.slice(0, 400).replace(/\n/g, ' ↵ ')
  const hint =
    opens === 0
      ? 'aucune accolade ouvrante — le modèle a refusé la tâche ou renvoyé du texte libre.'
      : opens > closes
        ? `JSON probablement tronqué (maxTokens atteint) : ${opens} { pour ${closes} }, et aucune opération récupérable.`
        : 'structure JSON incohérente.'
  throw new Error(
    `Réponse Wiki Builder invalide : ${hint}\n\n` +
      `Longueur : ${raw.length} chars. Début de la réponse : "${head}"`
  )
}

// Validation finale d'un objet JSON parsé en `WikiBuilderParsedResponse`.
// Filtre les operations malformées (sans throw) et fournit indexUpdate/
// logEntry par défaut si manquants.
function finalizeParsedResponse(parsed: unknown): WikiBuilderParsedResponse {
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

// Retire les fences markdown ```json ... ``` ou ``` ... ``` que certains
// modèles ajoutent malgré l'instruction "pas de markdown fence". Pattern
// volontairement greedy pour gérer plusieurs blocs. Si le résultat strippé
// est vide, on retombe sur l'original (mieux vaut essayer de parser le
// texte brut que d'échouer silencieusement).
function stripMarkdownCodeFence(s: string): string {
  const trimmed = s.trim()
  // Cas principal : fence entière englobant la réponse
  const fenceMatch = trimmed.match(/^```(?:json|javascript|js)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i)
  if (fenceMatch) return fenceMatch[1]
  // Cas variant : fence en tête/fin mais du texte explicatif autour
  // → on retire juste les lignes ```… qui restent, le parser extractJsonObject
  //   s'occupera de trouver le {} au milieu.
  return trimmed.replace(/^```[a-zA-Z]*\s*\r?\n/gm, '').replace(/\r?\n```\s*$/gm, '')
}

// Récupération tolérante : extrait UNE PAR UNE les opérations valides
// du tableau `operations: [...]` même si le JSON global est tronqué.
// Approche : trouve le pattern `"operations": [` puis itère object par
// object en utilisant `extractJsonObject` à chaque position. Garde ceux
// qui parsent + ont la structure attendue. Skippe le reste.
function extractPartialOperations(s: string): WikiBuilderOp[] {
  const opsKeyMatch = s.match(/"operations"\s*:\s*\[/)
  if (!opsKeyMatch) return []
  let cursor = (opsKeyMatch.index ?? 0) + opsKeyMatch[0].length
  const results: WikiBuilderOp[] = []
  while (cursor < s.length) {
    // Cherche la prochaine accolade ouvrante
    const nextOpen = s.indexOf('{', cursor)
    if (nextOpen === -1) break
    // Vérifie qu'on n'a pas dépassé le tableau (`]` rencontré avant `{`)
    const nextClose = s.indexOf(']', cursor)
    if (nextClose !== -1 && nextClose < nextOpen) break

    const objText = extractJsonObject(s.slice(nextOpen))
    if (!objText) break // JSON tronqué juste sur cet objet

    try {
      const parsed = JSON.parse(objText)
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { op?: unknown }).op === 'string' &&
        typeof (parsed as { filename?: unknown }).filename === 'string' &&
        typeof (parsed as { content?: unknown }).content === 'string'
      ) {
        const op = (parsed as { op: string }).op
        if (op === 'create' || op === 'update' || op === 'rename') {
          const rf = (parsed as { renameFrom?: unknown }).renameFrom
          results.push({
            op: op as WikiBuilderOp['op'],
            filename: (parsed as { filename: string }).filename,
            content: (parsed as { content: string }).content,
            renameFrom: typeof rf === 'string' ? rf : undefined
          })
        }
      }
    } catch {
      // objet malformé — skip
    }

    cursor = nextOpen + objText.length
  }
  return results
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

// Construit la section `## Corrections ciblées` du prompt WB à partir de la
// liste d'issues "safe". Retourne une chaîne vide si aucune issue — le
// caller omet alors la section du prompt. Plafonne à MAX_INJECTED issues
// pour garder la taille du prompt bornée (le WB converge naturellement
// vers 0 sur 2-3 compilations successives si le raw est stable).
function buildCorrectionsBlock(issues: LintIssue[]): string {
  if (issues.length === 0) return ''
  const MAX_INJECTED = 30
  const head = issues.slice(0, MAX_INJECTED)
  const overflow = issues.length - MAX_INJECTED
  const lines = [
    "## Corrections ciblées détectées par l'auditeur",
    '',
    "L'auditeur (`wiki-lint`) a identifié ces issues dans le wiki existant. **Tente** de les corriger PENDANT cette compilation si tu as assez de contexte pour le faire sans ambiguïté :",
    '',
    "- `broken-ref` : remplace le wikilink dans la page source par la cible correcte (parmi les articles existants) via un `update`. Si aucune cible évidente n'existe, laisse en l'état — ne crée pas une page stub.",
    "- `orphan-source` : retire l'entrée manquante du tableau `sources:` dans le frontmatter de la page, via un `update`.",
    '',
    'Tu restes **conservateur** : jamais de `rename`/`delete` sur la base d\'un lint seul. Si une issue te semble ambiguë, ignore-la — un futur run s\'en occupera.',
    '',
    '### Issues',
    '',
    ...head.map(
      (iss) => `- **${iss.kind}** sur \`${iss.pages.join(' / ')}\` — ${iss.description}`
    )
  ]
  if (overflow > 0) {
    lines.push('', `_(${overflow} issue${overflow > 1 ? 's' : ''} similaire${overflow > 1 ? 's' : ''} en plus — seront traitées au prochain run.)_`)
  }
  return lines.join('\n')
}

// ──────────────────────────────────────────────────────────── Lint (Sprint 4)

// Exécute l'agent Lint. Passe l'agent (pour model/temperature/maxTokens
// du check contradictions) à `runWikiLint`, qui tolère `null` si l'agent
// n'existe pas ou est désactivé (auquel cas seuls les 6 checks
// déterministes tournent — gratuits, utiles même sans LLM).
export async function runLint(): Promise<LintReport> {
  const agent = getAgentByKind('lint')
  return runWikiLint(agent && agent.enabled ? agent : null)
}

// ──────────────────────────────────────────────────────────── Researcher (Sprint 5)

// Exécute l'agent Researcher : identifie les infos du wiki à vérifier,
// lance les recherches web via Tavily, produit et applique les updates.
// Coûteux (2 appels LLM + N appels Tavily) — le bouton UI est gated par
// `enabled` de l'agent (off par défaut).
export async function runResearcher(): Promise<ResearchResult> {
  const agent = getAgentByKind('researcher')
  if (!agent) {
    throw new Error(
      "Agent Researcher introuvable. La DB a-t-elle été correctement migrée ?"
    )
  }
  if (!agent.enabled) {
    throw new Error(
      "Agent Researcher désactivé. Activez-le dans Paramètres > Agents (nécessite une clé Tavily)."
    )
  }
  return researchAndUpdate(agent)
}

// ──────────────────────────────────────────────────────────── File-back (Sprint 3)

// Pattern Karpathy "file answers back" : transforme un échange Q/R du chat
// en page wiki `qa/*.md` réutilisable. L'utilisateur clique un bouton sur
// une réponse assistant, on récupère la question précédente + la réponse,
// et on demande à un LLM de produire une page wiki structurée dédiée.
//
// Configurable via Settings > Agents depuis le Sprint 5 : le prompt / model /
// temperature / maxTokens sont lus depuis l'entrée `agent.file_back` de la
// table agents (seedée avec FILE_BACK_PROMPT_V1 en db.ts).

export async function runFileBackResponse(
  conversationId: string,
  assistantMessageId: string
): Promise<{ filename: string; logEntry: string }> {
  const conv = getConversation(conversationId)
  if (!conv) throw new Error(`Conversation ${conversationId} introuvable.`)

  const messages = listMessages(conversationId)
  const idx = messages.findIndex((m) => m.id === assistantMessageId)
  if (idx === -1) throw new Error(`Message ${assistantMessageId} introuvable dans la conversation.`)
  const assistant = messages[idx]
  if (assistant.role !== 'assistant') {
    throw new Error('Le message ciblé doit être une réponse assistant.')
  }
  // Cherche la question user la plus récente avant cette réponse.
  let userQ: (typeof messages)[number] | null = null
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userQ = messages[i]
      break
    }
  }
  if (!userQ) {
    throw new Error("Aucune question utilisateur trouvée avant cette réponse.")
  }

  // Configuration lue depuis la DB (Sprint 5 — agent file_back seedé).
  // Fallback sur le Wiki Builder si, pour une raison étrange, l'agent
  // file_back a été supprimé ou est désactivé — la feature doit rester
  // utilisable même si l'user a trafiqué la DB.
  const fileBack = getAgentByKind('file_back')
  const fallback = getAgentByKind('wiki_builder')
  const agent = fileBack && fileBack.enabled ? fileBack : fallback
  if (!agent) {
    throw new Error('Agent QA Filer introuvable. Relancez BlowWorks pour re-seed la DB.')
  }

  const userPrompt = [
    "## Échange à filer",
    '',
    "### Question utilisateur",
    '',
    userQ.content,
    '',
    "### Réponse assistant",
    '',
    assistant.content,
    '',
    '## Tâche',
    "Produis le JSON avec la page wiki qa/ correspondante."
  ].join('\n\n')

  const result = await oneShotChat({
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    userPrompt,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens
  })
  if (result.error) {
    throw new Error(`Échec QA Filer : ${result.error}`)
  }

  // Parse le JSON. Tolérant fences comme pour Wiki Builder.
  const stripped = stripMarkdownCodeFence(result.content)
  const jsonText = extractJsonObject(stripped)
  if (!jsonText) {
    throw new Error('Réponse QA Filer invalide : aucun JSON détecté.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Réponse QA Filer invalide : JSON malformé (${msg}).`)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { filename?: unknown }).filename !== 'string' ||
    typeof (parsed as { content?: unknown }).content !== 'string'
  ) {
    throw new Error('Réponse QA Filer invalide : filename ou content manquant.')
  }
  const obj = parsed as { filename: string; content: string; logEntry?: string }

  // Strip le prefix `wiki/` si l'agent l'a ajouté malgré l'instruction
  // (writeWiki l'ajoute déjà au niveau FS).
  let cleanFilename = obj.filename.replace(/\\/g, '/').trim()
  if (cleanFilename.startsWith('./')) cleanFilename = cleanFilename.slice(2)
  if (cleanFilename.startsWith('/')) cleanFilename = cleanFilename.slice(1)
  if (cleanFilename.startsWith('wiki/')) cleanFilename = cleanFilename.slice(5)

  await wiki.writeWiki(cleanFilename, obj.content)
  const logEntry =
    typeof obj.logEntry === 'string' && obj.logEntry.trim().length > 0
      ? obj.logEntry
      : `## [${new Date().toISOString()}] file-back | ${cleanFilename}`
  try {
    await wiki.appendLog(logEntry + '\n')
  } catch (e) {
    console.warn('[qa-filer] appendLog échoué :', e)
  }

  return { filename: cleanFilename, logEntry }
}
