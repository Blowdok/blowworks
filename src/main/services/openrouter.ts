import { safeStorage } from 'electron'
import { getDb } from './db.js'
import type { AIModelT } from '@shared/ipc-contract.js'
import { WIKI_TOOL_SCHEMAS, TOOLS_REQUIRE_CONFIRMATION } from '@shared/ai-tool-schemas.js'
import type { ToolCall, ToolResult } from '@shared/ai-tool-schemas.js'
import * as Tavily from './tavily.js'
import { executeAiTool } from './ai-tools.js'
import { awaitToolConfirmation, cancelAllToolConfirmations } from './ai-tool-confirmation.js'

// Service OpenRouter : liste des modèles (cache 1h) + streaming chat
// completions (SSE → callback par delta). Appelé UNIQUEMENT depuis le
// main process : la clé API n'est jamais exposée au renderer.
//
// La CSP du renderer (src/renderer/index.html) bloque `connect-src`
// vers openrouter.ai, c'est donc une contrainte architecturale ET un
// bénéfice de sécurité (clé isolée, fuite impossible via devtools).

const KEY_OPENROUTER_ENC = 'ai.openrouter.key.encrypted'
const KEY_DEFAULTS = 'ai.defaults'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

// Cache des modèles : OpenRouter expose 300+ modèles, la réponse fait
// ~500KB. On cache 1h — suffisant, l'utilisateur ne mute pas sa liste
// de modèles toutes les minutes, et un refresh manuel reste possible
// (forceRefresh=true depuis le ModelSelector).
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000
let modelsCache: { fetchedAt: number; data: AIModelT[] } | null = null

// Map des streams en cours, indexés par requestId. Permet à
// `cancelStream(requestId)` d'aborter un stream depuis le renderer
// quand l'utilisateur clique sur "Stop".
const activeControllers = new Map<string, AbortController>()

// ──────────────────────────────────────────────────────────── Stockage clé

function readSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export function hasOpenRouterKey(): boolean {
  return readSetting(KEY_OPENROUTER_ENC) !== null
}

export function setOpenRouterKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Chiffrement système indisponible : impossible de stocker la clé OpenRouter de façon sûre.'
    )
  }
  const encrypted = safeStorage.encryptString(key).toString('base64')
  writeSetting(KEY_OPENROUTER_ENC, encrypted)
  // Invalide le cache modèles : la nouvelle clé peut débloquer des
  // modèles privés indispo avec l'ancienne (ou au contraire, réduire
  // l'accès). Force un refetch au prochain `listModels()`.
  modelsCache = null
}

export function clearOpenRouterKey(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(KEY_OPENROUTER_ENC)
  modelsCache = null
}

function getOpenRouterKey(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const enc = readSetting(KEY_OPENROUTER_ENC)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────── Défauts

export interface AIDefaults {
  model: string
  temperature: number
  maxTokens: number
}

const FALLBACK_DEFAULTS: AIDefaults = {
  model: 'anthropic/claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096
}

export function getDefaults(): AIDefaults {
  const raw = readSetting(KEY_DEFAULTS)
  if (!raw) return { ...FALLBACK_DEFAULTS }
  try {
    const parsed = JSON.parse(raw) as Partial<AIDefaults>
    return {
      model: parsed.model ?? FALLBACK_DEFAULTS.model,
      temperature: parsed.temperature ?? FALLBACK_DEFAULTS.temperature,
      maxTokens: parsed.maxTokens ?? FALLBACK_DEFAULTS.maxTokens
    }
  } catch {
    return { ...FALLBACK_DEFAULTS }
  }
}

export function setDefaults(next: AIDefaults): void {
  writeSetting(KEY_DEFAULTS, JSON.stringify(next))
}

// ──────────────────────────────────────────────────────────── Modèles

interface RawModel {
  id?: string
  name?: string
  context_length?: number
  pricing?: { prompt?: string | number; completion?: string | number }
  architecture?: { modality?: string }
}

// Convertit un modèle OpenRouter brut au format interne. OpenRouter
// livre les prix en string ("0.000003" $ par token), on parse en number.
function normalizeModel(raw: RawModel): AIModelT | null {
  if (!raw.id || !raw.name || !raw.context_length) return null
  const pPrompt = Number(raw.pricing?.prompt ?? 0)
  const pComp = Number(raw.pricing?.completion ?? 0)
  if (!Number.isFinite(pPrompt) || !Number.isFinite(pComp)) return null
  return {
    id: raw.id,
    name: raw.name,
    contextLength: raw.context_length,
    pricing: { prompt: pPrompt, completion: pComp },
    modality: raw.architecture?.modality
  }
}

export async function listModels(options?: { forceRefresh?: boolean }): Promise<AIModelT[]> {
  const now = Date.now()
  if (
    !options?.forceRefresh &&
    modelsCache &&
    now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS
  ) {
    return modelsCache.data
  }

  const key = getOpenRouterKey()
  const headers: Record<string, string> = {
    'HTTP-Referer': 'https://blowworks.local',
    'X-Title': 'BlowWorks'
  }
  // `/models` est public côté OpenRouter (pas besoin de clé pour la liste),
  // mais on ajoute quand même l'auth si dispo — elle active la visibilité
  // de modèles privés/early-access pour les comptes concernés.
  if (key) headers['Authorization'] = `Bearer ${key}`

  const res = await fetch(`${OPENROUTER_BASE}/models`, { headers })
  if (!res.ok) {
    throw new Error(`OpenRouter /models HTTP ${res.status}`)
  }
  const payload = (await res.json()) as { data?: RawModel[] }
  const models = (payload.data ?? [])
    .map(normalizeModel)
    .filter((m): m is AIModelT => m !== null)
    // Tri alphabétique par nom visible — plus stable que par id.
    .sort((a, b) => a.name.localeCompare(b.name))

  modelsCache = { fetchedAt: now, data: models }
  return models
}

// ──────────────────────────────────────────────────────────── Streaming

// Format OpenAI/OpenRouter chat completion. On supporte maintenant les
// 4 rôles : system, user, assistant, tool (retour d'un tool call).
// `tool_calls` apparaît sur un message assistant quand il décide d'appeler
// un ou plusieurs tools. `tool_call_id` + `name` sur un message tool
// pour renvoyer le résultat associé.
export interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface StreamChatOptions {
  requestId: string
  model: string
  messages: ChatCompletionMessage[]
  temperature?: number
  maxTokens?: number
  systemPrompt?: string | null
  // Mémoire wiki partagée (lot 3). Injectée comme message `system` en
  // étape 1.5 — après le systemPrompt utilisateur, avant les résultats
  // Tavily — pour que le modèle ait accès à la mémoire long-terme avant
  // de considérer les résultats du search web courant.
  wikiContext?: string | null
  webSearchEnabled?: boolean
  webSearchQuery?: string
  // Active les tools wiki (read/write/search/rename/delete). Déclenche
  // une boucle agent multi-tours : le modèle peut lire et modifier le
  // wiki en cours de réponse, jusqu'à MAX_AGENT_ITER tours.
  wikiToolsEnabled?: boolean
}

export interface StreamChunk {
  delta?: string
  done?: boolean
  usage?: { promptTokens: number; completionTokens: number }
  citations?: string[]
  error?: string
  // Tool events (Sprint 2). Chaque chunk en porte au max un des trois.
  toolCall?: ToolCall
  toolResult?: { id: string; name: string; result: string; error?: string }
  toolConfirmNeeded?: ToolCall
}

// Limite d'itérations de la boucle agent (écho pattern nexusvault).
// 15 tours laissent au modèle la marge d'orchestrer plusieurs reads,
// un write, puis une réponse finale — sans permettre une boucle infinie.
const MAX_AGENT_ITER = 15

// Parse un flux SSE (ReadableStream de Uint8Array). OpenRouter suit le
// protocole OpenAI : lignes `data: {...}` séparées par `\n\n`, avec un
// terminateur `data: [DONE]`. On accumule les chunks en buffer string
// et on splitte sur `\n` — un chunk HTTP peut contenir plusieurs lignes
// OU une ligne partielle qu'il faut garder pour le prochain chunk.
async function* parseSSE(
  response: Response
): AsyncGenerator<Record<string, unknown>, void, void> {
  if (!response.body) throw new Error('Réponse OpenRouter sans body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE : les messages sont séparés par `\n\n`, chaque message
      // peut contenir plusieurs lignes (event:, data:, id:...). On ne
      // consomme QUE les messages complets ; le reste reste en buffer.
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return
          try {
            yield JSON.parse(data) as Record<string, unknown>
          } catch {
            /* chunk malformé, on ignore — le stream continue */
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// Lance un chat completion en streaming. Chaque delta déclenche `onChunk`.
// Le chunk final a `done: true` et contient `usage` + `citations`.
// En cas d'erreur réseau/HTTP, onChunk reçoit `{ error, done: true }`.
//
// Le webSearchEnabled déclenche un appel Tavily AVANT le stream : si
// Tavily échoue (timeout, clé manquante), on continue sans contexte web
// mais on émet un delta informatif dans le flux pour signaler le soft-fail.
export async function streamChat(
  opts: StreamChatOptions,
  onChunk: (chunk: StreamChunk) => void
): Promise<void> {
  const key = getOpenRouterKey()
  if (!key) {
    onChunk({
      error:
        'Aucune clé API OpenRouter enregistrée. Ouvrez Paramètres → OpenRouter pour la configurer.',
      done: true
    })
    return
  }

  // ── Étape 0 : ancrage temporel ──────────────────────────────────────
  // Injection systématique de la date/heure réelle pour contrer les
  // hallucinations temporelles (ex: le modèle croit qu'on est en 2024
  // alors qu'on est en 2026, puis flag à tort comme "prospectif" des
  // sources pourtant datées correctement). Fuseau horaire fixe
  // Asia/Dubai = UTC+4 (pas de DST) comme demandé.
  const messages: ChatCompletionMessage[] = [
    {
      role: 'system',
      content: buildTemporalAnchor({ webSearchEnabled: opts.webSearchEnabled ?? false })
    }
  ]
  const citations: string[] = []

  // ── Étape 1 : system prompt utilisateur ─────────────────────────────
  if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
    messages.push({ role: 'system', content: opts.systemPrompt })
  }

  // ── Étape 1.5 : wikiContext (mémoire long-terme partagée) ──────────
  // Injecté APRÈS le systemPrompt utilisateur pour que l'instruction
  // primaire prime, mais AVANT Tavily pour que le search web courant
  // puisse affiner la mémoire si nécessaire.
  if (opts.wikiContext && opts.wikiContext.trim().length > 0) {
    messages.push({
      role: 'system',
      content: opts.wikiContext
    })
  }

  if (opts.webSearchEnabled) {
    const currentQ = opts.webSearchQuery ?? getLastUserContent(opts.messages)
    const query = currentQ ? enrichSearchQuery(opts.messages, currentQ) : null
    if (query) {
      try {
        const r = await Tavily.search(query)
        messages.push({
          role: 'system',
          content: Tavily.formatSearchForPrompt(query, r)
        })
        for (const src of r.results) {
          if (src.url) citations.push(src.url)
        }
      } catch (e) {
        // Soft-fail : on signale à l'utilisateur via un delta en tête de
        // réponse, puis on continue sans contexte web — mieux que bloquer.
        const msg = e instanceof Error ? e.message : String(e)
        onChunk({ delta: `_⚠️ Recherche web indisponible (${msg}). Réponse sans contexte web._\n\n` })
      }
    }
  }

  // Messages historiques puis le prompt courant.
  messages.push(...opts.messages)

  // ── Étape 2 : boucle agent ──────────────────────────────────────────
  // Si `wikiToolsEnabled`, on entre dans une boucle multi-tours :
  //   - stream 1 tour → accumule delta + tool_calls
  //   - si finish_reason=tool_calls : exécute chaque call (avec
  //     confirmation pour les destructifs), push les résultats dans
  //     messages, et relance le stream
  //   - sinon : fin normale
  // Si `wikiToolsEnabled=false`, la boucle tourne une seule fois sans
  // tools — comportement identique à Sprint 1.
  const controller = new AbortController()
  activeControllers.set(opts.requestId, controller)

  let promptTokens = 0
  let completionTokens = 0
  let iter = 0

  try {
    agentLoop: while (iter < MAX_AGENT_ITER) {
      iter++
      const turn = await runOneTurn(key, controller.signal, messages, opts, onChunk)

      if (turn.error) {
        onChunk({ error: turn.error, done: true })
        return
      }
      promptTokens += turn.usage.promptTokens
      completionTokens += turn.usage.completionTokens

      if (turn.toolCalls.length === 0) {
        // Pas de tool_calls → fin normale.
        break agentLoop
      }

      // Le modèle a demandé des tools. On pousse son message assistant
      // avec `tool_calls`, puis on exécute séquentiellement (les calls
      // destructifs peuvent bloquer sur confirmation utilisateur).
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) }
        }))
      })

      for (const call of turn.toolCalls) {
        onChunk({ toolCall: call })

        // Confirmation pour les tools destructifs. Bloque jusqu'à
        // décision utilisateur (timeout 5 min → refus automatique).
        if (TOOLS_REQUIRE_CONFIRMATION.has(call.name)) {
          onChunk({ toolConfirmNeeded: call })
          const approved = await awaitToolConfirmation(call.id)
          if (!approved) {
            const errMsg =
              "ERREUR : l'utilisateur a refusé cette action destructive. Propose une alternative ou passe à autre chose."
            onChunk({
              toolResult: { id: call.id, name: call.name, result: '', error: errMsg }
            })
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: errMsg
            })
            continue
          }
        }

        // Exécute (les erreurs retournent comme `error` dans ToolResult,
        // ne throw pas — ça permet au modèle de corriger).
        const result: ToolResult = await executeAiTool(call)
        onChunk({
          toolResult: { id: call.id, name: call.name, result: result.result, error: result.error }
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: result.error ? `ERREUR : ${result.error}` : result.result || '(vide)'
        })
      }
      // On boucle pour que le modèle voit les tool_results et continue.
    }

    if (iter >= MAX_AGENT_ITER) {
      onChunk({
        delta:
          '\n\n_⚠️ Limite d\'itérations atteinte (' +
          MAX_AGENT_ITER +
          " tours d'outils). Stream arrêté pour éviter une boucle._\n"
      })
    }

    onChunk({
      done: true,
      usage: { promptTokens, completionTokens },
      citations: citations.length > 0 ? citations : undefined
    })
  } catch (e) {
    // AbortError (cancel utilisateur) est un flux normal → on émet
    // quand même un `done: true` pour que le renderer fasse son cleanup.
    if (e instanceof Error && e.name === 'AbortError') {
      cancelAllToolConfirmations()
      onChunk({ done: true, citations: citations.length > 0 ? citations : undefined })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    onChunk({ error: msg, done: true })
  } finally {
    activeControllers.delete(opts.requestId)
  }
}

// Exécute UN tour de stream OpenRouter. Accumule le texte (delta), les
// tool_calls partiels (concaténés sur plusieurs chunks SSE) et l'usage.
// Retourne quand le stream est fini (finish_reason détecté ou [DONE]).
async function runOneTurn(
  apiKey: string,
  signal: AbortSignal,
  messages: ChatCompletionMessage[],
  opts: StreamChatOptions,
  onChunk: (chunk: StreamChunk) => void
): Promise<{
  toolCalls: ToolCall[]
  usage: { promptTokens: number; completionTokens: number }
  error: string | null
}> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens
  }
  if (opts.wikiToolsEnabled) {
    body.tools = WIKI_TOOL_SCHEMAS
    body.tool_choice = 'auto'
  }

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://blowworks.local',
      'X-Title': 'BlowWorks'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      error: `OpenRouter HTTP ${res.status} : ${text.slice(0, 300)}`
    }
  }

  // Accumulateurs de tool_calls (le JSON des arguments arrive en N chunks).
  const toolAccs = new Map<
    number,
    { id: string; name: string; args: string }
  >()
  let promptTokens = 0
  let completionTokens = 0

  for await (const event of parseSSE(res)) {
    const choices = event.choices as
      | Array<{
          delta?: {
            content?: string
            tool_calls?: Array<{
              index: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
          finish_reason?: string | null
        }>
      | undefined
    const usage = event.usage as
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined
    if (usage) {
      promptTokens = usage.prompt_tokens ?? promptTokens
      completionTokens = usage.completion_tokens ?? completionTokens
    }

    const delta = choices?.[0]?.delta
    if (delta?.content) onChunk({ delta: delta.content })

    // Accumulation progressive des tool_calls. OpenRouter/OpenAI envoie
    // le JSON des arguments en plusieurs chunks — on concatène jusqu'à
    // finish_reason='tool_calls' où on a le JSON complet.
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const existing = toolAccs.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.arguments) existing.args += tc.function.arguments
        toolAccs.set(tc.index, existing)
      }
    }
  }

  // Parse les arguments JSON accumulés. Les calls sans id/name (malformés)
  // sont ignorés.
  const toolCalls: ToolCall[] = []
  for (const acc of toolAccs.values()) {
    if (!acc.id || !acc.name) continue
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = acc.args ? JSON.parse(acc.args) : {}
    } catch {
      parsedArgs = {}
    }
    toolCalls.push({ id: acc.id, name: acc.name, arguments: parsedArgs })
  }

  return {
    toolCalls,
    usage: { promptTokens, completionTokens },
    error: null
  }
}

// Appel one-shot (non-streamé) utilisé par les runners d'agents : on
// reconstruit simplement streamChat en accumulant les deltas et on
// retourne le texte complet. Évite la duplication de la logique
// d'authentification / Tavily / gestion d'erreurs.
//
// Timeout : 5 minutes par défaut. Les runs Wiki Builder peuvent être
// longs (gros contexte inliné) mais un run qui dépasse 5 min est
// probablement un modèle qui boucle / une connexion morte. On abort
// proprement plutôt que de laisser le renderer bloqué indéfiniment.
export async function oneShotChat(opts: {
  model: string
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}): Promise<{ content: string; error: string | null }> {
  const requestId = `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let assembled = ''
  let streamError: string | null = null

  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  const timer = setTimeout(() => {
    cancelStream(requestId)
  }, timeoutMs)

  try {
    await streamChat(
      {
        requestId,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        messages: [{ role: 'user', content: opts.userPrompt }],
        temperature: opts.temperature,
        maxTokens: opts.maxTokens
      },
      (chunk) => {
        if (chunk.delta) assembled += chunk.delta
        if (chunk.error) streamError = chunk.error
      }
    )
  } finally {
    clearTimeout(timer)
  }

  // Si on est arrivé ici sans texte ni erreur, c'est que le timeout a
  // coupé avant que le modèle ne streame quoi que ce soit. Signaler
  // explicitement pour que l'UI affiche un message actionnable.
  if (!assembled && !streamError) {
    streamError = `Timeout après ${Math.round(timeoutMs / 1000)}s sans réponse du modèle. Réduisez la taille du wiki ou réessayez.`
  }

  return { content: assembled, error: streamError }
}

export function cancelStream(requestId: string): boolean {
  const ctrl = activeControllers.get(requestId)
  if (!ctrl) return false
  ctrl.abort()
  activeControllers.delete(requestId)
  return true
}

function getLastUserContent(messages: ChatCompletionMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return null
}

// Enrichit une requête de recherche avec le contexte conversationnel
// pour éviter les requêtes orphelines style "quels sont les prochain
// match ?" qui n'ont aucun sens envoyées à Tavily telles quelles.
//
// Heuristique :
// - Si la question fait déjà ≥ 60 caractères, on la laisse — elle est
//   probablement autonome.
// - Sinon on cherche les 1-2 messages user précédents de la conversation
//   et on préfixe la question avec leur contenu tronqué.
// - On coupe à 500 caractères au total pour garder la query focalisée
//   (Tavily perd en précision sur les requêtes trop longues).
function enrichSearchQuery(
  messages: ChatCompletionMessage[],
  currentQuestion: string
): string {
  const trimmed = currentQuestion.trim()
  if (trimmed.length >= 60) return trimmed.slice(0, 500)

  // Collecte les messages user précédents (hors currentQuestion qui est
  // le dernier). On parcourt en reverse pour prendre les plus récents.
  const priorUserMessages: string[] = []
  for (let i = messages.length - 1; i >= 0 && priorUserMessages.length < 2; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    // `content` peut être null pour assistant tool-call ; pour user c'est
    // toujours string — cast défensif pour le typecheck.
    const text = typeof m.content === 'string' ? m.content : ''
    if (text.trim() === trimmed) continue // skip la question courante
    priorUserMessages.unshift(text.trim().slice(0, 180))
  }
  if (priorUserMessages.length === 0) return trimmed

  // Format : "Contexte: <msg N-1> // <msg N>. Question actuelle: <Q>"
  const context = priorUserMessages.join(' // ')
  const combined = `Contexte précédent : ${context}. Question actuelle : ${trimmed}`
  return combined.slice(0, 500)
}

// Formate un message système d'ancrage temporel + garde-fou capacités.
// Injecté à chaque streamChat pour :
//   1. Donner la date/heure réelle (fuseau Asia/Dubai) — contre les
//      hallucinations temporelles dues au training cutoff du modèle.
//   2. Clarifier quelles capacités sont réellement disponibles pour CE
//      tour précis. Sans cette garde, le modèle prétend parfois "avoir
//      fait une recherche web" alors qu'aucun contexte Tavily n'a été
//      injecté — il invente alors des sources et des faits plausibles
//      mais fabriqués (pattern classique d'hallucination).
function buildTemporalAnchor(opts: { webSearchEnabled: boolean }): string {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai'
  })
  const human = formatter.format(now)
  const iso = now.toISOString()
  return [
    `Date et heure actuelles : **${human}** (fuseau horaire Abou Dabi / Mascate, UTC+4).`,
    `ISO 8601 UTC : ${iso}`,
    '',
    "Utilise cette référence comme vérité de terrain. N'utilise JAMAIS une date issue de ton training cutoff pour évaluer si un événement est passé, futur ou \"prospectif\" — ça cause des hallucinations temporelles. Si l'utilisateur mentionne une date relative (\"hier\", \"la semaine prochaine\", \"dans 3 mois\"), résous-la à partir de la date ci-dessus.",
    '',
    '## Capacités disponibles pour CE tour',
    opts.webSearchEnabled
      ? "- ✅ Recherche web activée : un bloc `[Contexte web récupéré via Tavily …]` sera (ou ne sera pas) inséré ci-dessous selon les résultats. Si AUCUN bloc Tavily n'apparaît, ça veut dire qu'aucun résultat pertinent n'a été trouvé — dis-le honnêtement au lieu d'inventer."
      : "- ❌ Recherche web désactivée pour ce tour. Tu n'as PAS consulté internet. N'emploie JAMAIS de formulations comme \"d'après mes recherches sur le web\", \"j'ai consulté le web\", \"voici ce que j'ai trouvé en ligne\" — ce sont des mensonges. Si l'utilisateur te demande de chercher, réponds explicitement que la recherche web n'est pas activée (bouton 🌐 dans la zone de saisie) et propose la réponse à partir de tes connaissances générales, en le signalant comme tel."
  ].join('\n')
}

// Exposé pour les tests uniquement : permet d'injecter un état de cache
// connu avant d'appeler listModels.
export function __resetModelsCacheForTests(): void {
  modelsCache = null
}
