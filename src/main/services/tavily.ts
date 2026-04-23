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
  // `topic` = 'news' active le crawler d'actualités récentes (résultats
  // datés, presse généraliste). 'general' = recherche web standard.
  // Par défaut on auto-détecte via heuristique de mots-clés temporels.
  topic?: 'general' | 'news'
  // Quand topic=news, limite la fenêtre temporelle. Fortement utile pour
  // "prochain match", "aujourd'hui", "cette semaine" — évite de retomber
  // sur des articles de 2023.
  timeRange?: 'day' | 'week' | 'month' | 'year'
}

// Détection heuristique : la question porte-t-elle sur un événement
// courant/futur/récent ? Si oui, on bascule Tavily en mode news.
// Keywords volontairement larges pour ratisser français + anglais.
const TEMPORAL_KEYWORDS = [
  'prochain',
  'prochaine',
  'aujourd\'hui',
  'aujourd hui',
  'hier',
  'demain',
  'cette semaine',
  'ce mois',
  'cette année',
  'actuel',
  'actuelle',
  'récent',
  'récente',
  'maintenant',
  'en ce moment',
  'dernier',
  'dernière',
  'upcoming',
  'today',
  'yesterday',
  'tomorrow',
  'this week',
  'this month',
  'recent',
  'latest',
  'current',
  'now'
]

export function detectTemporalIntent(query: string): boolean {
  const q = query.toLowerCase()
  return TEMPORAL_KEYWORDS.some((k) => q.includes(k))
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

  // Si topic non-forcé, on auto-détecte via les mots-clés temporels.
  const topic: 'general' | 'news' = opts.topic ?? (detectTemporalIntent(query) ? 'news' : 'general')
  // Par défaut : fenêtre courte (week) si topic=news, sinon pas de contrainte.
  const timeRange = opts.timeRange ?? (topic === 'news' ? 'week' : undefined)

  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const body: Record<string, unknown> = {
      api_key: apiKey,
      query,
      // `advanced` coûte plus cher mais retourne des snippets plus
      // longs et des scores de pertinence mieux calibrés — vaut le coup
      // pour un outil desktop où la qualité prime sur le coût unitaire.
      search_depth: opts.depth ?? 'advanced',
      max_results: opts.maxResults ?? 8,
      include_answer: true,
      topic
    }
    if (timeRange) body.time_range = timeRange

    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(body)
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
//
// Les consignes finales sont strictes : si les sources ne contiennent
// PAS la réponse, le modèle doit le dire plutôt qu'inventer des faits
// plausibles (ex: programmer des matchs de Ligue des Champions avec des
// équipes au hasard au lieu de reconnaître qu'il n'a pas l'info).
export function formatSearchForPrompt(query: string, r: TavilySearchResponse): string {
  const lines: string[] = [
    `[Contexte web récupéré via Tavily pour la requête : "${query}"]`
  ]
  if (r.answer) {
    lines.push('', 'Réponse rapide synthétisée par Tavily :', r.answer)
  }
  if (r.results.length > 0) {
    lines.push('', `Sources (${r.results.length}, triées par pertinence) :`)
    for (const [i, src] of r.results.entries()) {
      const snippet = src.content.slice(0, 500).replace(/\s+/g, ' ').trim()
      lines.push(`${i + 1}. [${src.title}](${src.url})`, `   ${snippet}`)
    }
  } else {
    lines.push('', '**Aucune source pertinente retournée par Tavily pour cette requête.**')
  }
  lines.push(
    '',
    '## Règles de réponse',
    "- Base-toi EXCLUSIVEMENT sur les sources ci-dessus pour les faits factuels (dates, scores, noms, affiches).",
    "- Cite les sources en markdown `[titre](url)` à côté de chaque fait factuel.",
    "- Si les sources ne contiennent PAS la réponse demandée, dis-le explicitement — NE PAS extrapoler ni inventer des affiches, dates ou résultats plausibles.",
    "- Ne conjugue JAMAIS ton training cutoff avec ces sources : les sources priment."
  )
  return lines.join('\n')
}
