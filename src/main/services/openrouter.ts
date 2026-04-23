import { safeStorage } from 'electron'
import { getDb } from './db.js'
import type { AIModelT } from '@shared/ipc-contract.js'
import * as Tavily from './tavily.js'

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

export interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
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
}

export interface StreamChunk {
  delta?: string
  done?: boolean
  usage?: { promptTokens: number; completionTokens: number }
  citations?: string[]
  error?: string
}

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

  // ── Étape 1 : system prompt utilisateur ─────────────────────────────
  const messages: ChatCompletionMessage[] = []
  const citations: string[] = []

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
    const query = opts.webSearchQuery ?? getLastUserContent(opts.messages)
    if (query) {
      try {
        const r = await Tavily.search(query, { depth: 'basic', maxResults: 5 })
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

  // ── Étape 2 : stream OpenRouter ─────────────────────────────────────
  const controller = new AbortController()
  activeControllers.set(opts.requestId, controller)

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://blowworks.local',
        'X-Title': 'BlowWorks'
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        stream: true,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens
      })
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      onChunk({
        error: `OpenRouter HTTP ${res.status} : ${text.slice(0, 300)}`,
        done: true
      })
      return
    }

    let promptTokens = 0
    let completionTokens = 0

    for await (const event of parseSSE(res)) {
      // Format OpenAI/OpenRouter : `choices[0].delta.content` pour le
      // delta texte, `usage` sur le dernier event (non-standard SSE mais
      // OpenRouter l'envoie systématiquement).
      const choices = event.choices as
        | Array<{ delta?: { content?: string }; finish_reason?: string | null }>
        | undefined
      const usage = event.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined
      if (usage) {
        promptTokens = usage.prompt_tokens ?? promptTokens
        completionTokens = usage.completion_tokens ?? completionTokens
      }
      const content = choices?.[0]?.delta?.content
      if (content) onChunk({ delta: content })
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
      onChunk({ done: true, citations: citations.length > 0 ? citations : undefined })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    onChunk({ error: msg, done: true })
  } finally {
    activeControllers.delete(opts.requestId)
  }
}

// Appel one-shot (non-streamé) utilisé par les runners d'agents : on
// reconstruit simplement streamChat en accumulant les deltas et on
// retourne le texte complet. Évite la duplication de la logique
// d'authentification / Tavily / gestion d'erreurs.
export async function oneShotChat(opts: {
  model: string
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
}): Promise<{ content: string; error: string | null }> {
  const requestId = `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let assembled = ''
  let streamError: string | null = null

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

// Exposé pour les tests uniquement : permet d'injecter un état de cache
// connu avant d'appeler listModels.
export function __resetModelsCacheForTests(): void {
  modelsCache = null
}
