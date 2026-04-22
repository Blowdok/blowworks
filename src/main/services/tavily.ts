import { safeStorage } from 'electron'
import { getDb } from './db.js'

// Service de recherche web via Tavily. Appelé depuis `openrouter.ts` quand
// l'utilisateur active le bouton 🌐 dans ChatInput — les résultats sont
// injectés comme message système avant l'envoi au modèle OpenRouter.
//
// La clé Tavily est stockée chiffrée (safeStorage) dans la table `settings`
// sous la clé `ai.tavily.key.encrypted`. Le renderer ne la reçoit jamais.

const KEY_TAVILY_ENC = 'ai.tavily.key.encrypted'

// Endpoint officiel. Tavily ne demande pas de HTTP-Referer particulier.
const TAVILY_URL = 'https://api.tavily.com/search'

// Timeout 15 s : la recherche web ne doit pas faire traîner le cycle
// requête utilisateur. Au-delà, on abandonne et on envoie la requête
// au modèle SANS contexte web (soft-fail) — voir callers.
const DEFAULT_TIMEOUT_MS = 15_000

export interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
}

export interface TavilySearchResponse {
  answer: string | null
  results: TavilyResult[]
}

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

export function hasTavilyKey(): boolean {
  return readSetting(KEY_TAVILY_ENC) !== null
}

// Stocke la clé Tavily chiffrée. `safeStorage.isEncryptionAvailable()`
// peut être faux sur Linux sans keyring — dans ce cas, on n'écrit rien
// et la UI renvoie `encryptionAvailable: false` dans le status API.
export function setTavilyKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Chiffrement système indisponible : impossible de stocker la clé Tavily de façon sûre.'
    )
  }
  const encrypted = safeStorage.encryptString(key).toString('base64')
  writeSetting(KEY_TAVILY_ENC, encrypted)
}

export function clearTavilyKey(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(KEY_TAVILY_ENC)
}

function getTavilyKey(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const enc = readSetting(KEY_TAVILY_ENC)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────── Recherche

export interface TavilySearchOptions {
  depth?: 'basic' | 'advanced'
  maxResults?: number
  timeoutMs?: number
}

export async function search(
  query: string,
  opts: TavilySearchOptions = {}
): Promise<TavilySearchResponse> {
  const apiKey = getTavilyKey()
  if (!apiKey) {
    throw new Error(
      'Aucune clé API Tavily enregistrée. Ouvrez Paramètres → Recherche web pour la configurer.'
    )
  }

  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: opts.depth ?? 'basic',
        max_results: opts.maxResults ?? 5,
        include_answer: true
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Tavily HTTP ${res.status} : ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      answer?: string
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
    }
    return {
      answer: data.answer ?? null,
      results: (data.results ?? []).map((r) => ({
        title: r.title ?? '(sans titre)',
        url: r.url ?? '',
        content: r.content ?? '',
        score: r.score ?? 0
      }))
    }
  } finally {
    clearTimeout(timeout)
  }
}

// Formate la réponse Tavily pour injection comme message système
// additionnel, juste avant la requête user. Le modèle reçoit alors un
// contexte web à jour et doit citer ses sources via les URLs fournies.
export function formatSearchForPrompt(query: string, r: TavilySearchResponse): string {
  const lines: string[] = [
    `[Contexte web récupéré via Tavily pour la requête : "${query}"]`
  ]
  if (r.answer) {
    lines.push('', 'Réponse rapide synthétisée :', r.answer)
  }
  if (r.results.length > 0) {
    lines.push('', 'Sources (cite-les en markdown quand tu les utilises) :')
    for (const [i, src] of r.results.entries()) {
      const snippet = src.content.slice(0, 500).replace(/\s+/g, ' ').trim()
      lines.push(`${i + 1}. [${src.title}](${src.url})`, `   ${snippet}`)
    }
  }
  lines.push(
    '',
    'Consigne : utilise ces sources pour répondre avec précision et actualité,',
    "et inclus les liens [titre](url) dans ta réponse quand c'est pertinent."
  )
  return lines.join('\n')
}
