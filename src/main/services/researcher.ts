import * as Tavily from './tavily.js'
import * as wiki from './wiki-fs.js'
import { oneShotChat } from './openrouter.js'
import type { AgentT } from '@shared/ipc-contract.js'

// Agent Researcher (Sprint 5) — actualise le wiki via recherches web.
//
// Stratégie 2-phases (pas de tool-calling full pour rester simple et
// prévisible) :
//
//   Phase 1 — identification :
//     LLM lit le wiki, identifie les infos potentiellement obsolètes
//     (versions de packages, dates, prix, APIs deprecated, statut de
//     services/frameworks). Retourne UN JSON { queries: [{ page, field,
//     query }, ...] } — max 10 queries pour borner le coût.
//
//   Phase 2 — exécution + synthèse :
//     On lance les `Tavily.search(query)` en parallèle (timeouts isolés).
//     On ré-envoie au LLM : wiki + résultats de recherche → il produit
//     un JSON d'`operations` similaire au Wiki Builder, avec tracking
//     des sources dans frontmatter.sources (url + date).
//
//   Phase 3 — application :
//     On applique les `update` via `wiki.writeWiki`. Pas de `rename`/
//     `delete` autorisés pour un researcher (read-only du point de vue
//     structure — il enrichit seulement).
//
// Coût borné à 2 appels LLM + N appels Tavily (N ≤ 10) par run. Si la
// phase 1 retourne 0 query, on skip la phase 2 (no-op gratuit).

export interface ResearchResult {
  queriesMade: number
  operations: Array<{ op: string; filename: string; bytes: number }>
  logEntry: string
}

interface Phase1Query {
  page: string
  field: string
  query: string
}

interface SearchOutcome {
  query: Phase1Query
  answer: string | null
  results: Array<{ title: string; url: string; content: string; score: number }>
  error: string | null
}

const MAX_QUERIES = 10

const PHASE1_PROMPT = `Tu es l'agent Researcher de BlowWorks — spécialiste de la vérification de faits.

Tu reçois l'inventaire d'un wiki markdown (titres, frontmatter, corps). Ta tâche : identifier les énoncés qui méritent une vérification web.

## Cibles prioritaires
- Versions de packages / frameworks (ex: "Next.js 14", "Python 3.11")
- Dates de releases, roadmaps, deadlines passées
- Prix de services (hébergeur, SaaS, API)
- APIs marquées "deprecated" ou "beta"
- Statuts de projets tiers (encore maintenu ? racheté ? fermé ?)
- Pages marquées \`statut: to-verify\` dans le frontmatter

## Ignore
- Concepts stables (algorithmes, notions théoriques, principes généraux)
- Anecdotes personnelles ou notes subjectives
- Pages \`statut: verified\` modifiées récemment (< 30 jours), sauf si cible prioritaire

## Format de sortie — JSON strict, pas de markdown fence
{
  "queries": [
    { "page": "concepts/next-js.md", "field": "version majeure", "query": "Next.js latest stable version 2025" }
  ]
}

Limite à ${MAX_QUERIES} queries max (priorité aux pages "to-verify" + pages les plus critiques). Si aucune vérification nécessaire, retourne \`{"queries":[]}\`.`

const PHASE2_PROMPT = `Tu es l'agent Researcher de BlowWorks. Tu as reçu :
1. Le wiki existant (intégral)
2. Les résultats de recherches web ciblées sur les points à vérifier

Ta tâche : produire des \`operations\` de type \`update\` pour actualiser les pages concernées UNIQUEMENT quand les sources web contredisent / précisent l'info actuelle.

## Règles

- \`op\` : toujours \`"update"\` (ni \`create\`, ni \`rename\`, ni \`delete\` — un researcher n'altère pas la structure).
- \`filename\` : chemin relatif au dossier wiki/ (ex: \`concepts/next-js.md\`), PAS de prefix \`wiki/\`.
- Le \`content\` doit être la page COMPLÈTE mise à jour (frontmatter + corps), pas un diff.
- Frontmatter mis à jour :
  - \`statut: verified\` si l'info est désormais confirmée par une source web.
  - \`modifié: <date ISO du jour>\`
  - \`sources: [...]\` → **ajoute** les URLs consultées en gardant les sources existantes. Format préféré : tableau inline de strings.
- Dans le corps : mentionne l'info mise à jour avec citation courte "(source: domaine.com, vérifié YYYY-MM-DD)".
- Si une recherche n'a rien apporté de concluant, NE PAS toucher à la page.
- Conserve le reste du contenu et du style intacts — tu es un FACT-CHECKER, pas un rewriter.

## Format de sortie — JSON strict
{
  "operations": [
    { "op": "update", "filename": "concepts/next-js.md", "content": "<page complète>", "reason": "version 15 confirmée via next.js/blog" }
  ],
  "logEntry": "## [ISO8601] researcher | N pages actualisées via M recherches"
}

Pas de markdown fence, pas de préambule.`

export async function researchAndUpdate(agent: AgentT): Promise<ResearchResult> {
  if (!Tavily.hasTavilyKey()) {
    throw new Error(
      "Aucune clé API Tavily configurée. Ouvrez Paramètres → OpenRouter pour la renseigner (section Recherche web)."
    )
  }

  const entries = await wiki.listWiki()
  if (entries.length === 0) {
    return { queriesMade: 0, operations: [], logEntry: 'researcher | no-op (wiki vide)' }
  }

  // Charge le wiki complet UNE fois. Réutilisé en phase 1 et phase 2.
  const pages = await Promise.all(
    entries.map(async (e) => {
      try {
        const content = await wiki.readWiki(e.name)
        return { name: e.name, content, modifiedAt: e.modifiedAt }
      } catch {
        return null
      }
    })
  )
  const validPages = pages.filter((p): p is NonNullable<typeof p> => p !== null)

  const wikiBlock = buildWikiBlock(validPages)

  // ── Phase 1 : identifier les queries ────────────────────────────────
  const phase1 = await oneShotChat({
    model: agent.model,
    systemPrompt: PHASE1_PROMPT,
    userPrompt: `## Wiki à auditer\n\n${wikiBlock}\n\n## Tâche\n\nRetourne le JSON des queries à lancer.`,
    temperature: agent.temperature,
    // Phase 1 produit juste une liste de ~10 queries : 2k tokens suffisent.
    maxTokens: 2048
  })
  if (phase1.error) throw new Error(`Phase 1 échouée : ${phase1.error}`)

  const queries = parsePhase1Queries(phase1.content).slice(0, MAX_QUERIES)
  console.log(`[researcher] phase 1 : ${queries.length} queries identifiées`)

  if (queries.length === 0) {
    const logEntry = `## [${new Date().toISOString()}] researcher | no-op (aucune info à vérifier)`
    await wiki.appendLog(logEntry + '\n')
    return { queriesMade: 0, operations: [], logEntry }
  }

  // ── Phase 2a : exécuter les recherches Tavily ──────────────────────
  const outcomes: SearchOutcome[] = await Promise.all(
    queries.map(async (q) => {
      try {
        const r = await Tavily.search(q.query, { maxResults: 5 })
        return { query: q, answer: r.answer, results: r.results, error: null }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { query: q, answer: null, results: [], error: msg }
      }
    })
  )
  const successfulSearches = outcomes.filter((o) => o.error === null).length
  console.log(
    `[researcher] phase 2a : ${successfulSearches}/${queries.length} recherches réussies`
  )

  if (successfulSearches === 0) {
    throw new Error(
      `Toutes les recherches Tavily ont échoué. Première erreur : ${outcomes[0].error ?? '(inconnue)'}`
    )
  }

  // ── Phase 2b : synthèse LLM avec résultats ─────────────────────────
  const phase2 = await oneShotChat({
    model: agent.model,
    systemPrompt: agent.systemPrompt && agent.systemPrompt.trim().length > 0 ? agent.systemPrompt : PHASE2_PROMPT,
    userPrompt: buildPhase2Prompt(wikiBlock, outcomes),
    temperature: agent.temperature,
    maxTokens: agent.maxTokens
  })
  if (phase2.error) throw new Error(`Phase 2 échouée : ${phase2.error}`)

  const parsed = parseOperations(phase2.content)

  // ── Phase 3 : appliquer les updates ────────────────────────────────
  const applied: ResearchResult['operations'] = []
  for (const op of parsed.operations) {
    try {
      const cleanFilename = stripWikiPrefix(op.filename)
      // On ne tolère QUE update — rien d'autre pour un researcher.
      if (op.op !== 'update') {
        console.warn(`[researcher] op "${op.op}" ignorée (seul update autorisé) :`, cleanFilename)
        continue
      }
      await wiki.writeWiki(cleanFilename, op.content)
      applied.push({ op: op.op, filename: cleanFilename, bytes: op.content.length })
    } catch (e) {
      console.error(`[researcher] write échoué pour ${op.filename} :`, e)
    }
  }

  const logEntry =
    parsed.logEntry ||
    `## [${new Date().toISOString()}] researcher | ${applied.length} pages actualisées via ${successfulSearches} recherches`
  try {
    await wiki.appendLog(logEntry + '\n')
  } catch (e) {
    console.warn('[researcher] appendLog échoué :', e)
  }

  return { queriesMade: queries.length, operations: applied, logEntry }
}

// ─────────────────────────────────────────────────────────── helpers

function buildWikiBlock(pages: Array<{ name: string; content: string }>): string {
  return pages.map((p) => `### wiki/${p.name}\n\n${p.content}`).join('\n\n---\n\n')
}

function buildPhase2Prompt(wikiBlock: string, outcomes: SearchOutcome[]): string {
  const searchBlock = outcomes
    .map((o, i) => {
      const q = o.query
      if (o.error) {
        return `### Recherche ${i + 1} — ÉCHEC\n- Cible : wiki/${q.page} (${q.field})\n- Query : ${q.query}\n- Erreur : ${o.error}`
      }
      const resultsBlock = o.results
        .map((r) => `  - **${r.title}** (${r.url})\n    ${r.content.slice(0, 500)}${r.content.length > 500 ? '…' : ''}`)
        .join('\n')
      const answerBlock = o.answer ? `  Résumé : ${o.answer}\n` : ''
      return `### Recherche ${i + 1}\n- Cible : wiki/${q.page} (${q.field})\n- Query : ${q.query}\n${answerBlock}- Résultats :\n${resultsBlock}`
    })
    .join('\n\n')

  return [
    '## Wiki existant',
    '',
    wikiBlock,
    '',
    '## Résultats des recherches web',
    '',
    searchBlock,
    '',
    '## Tâche',
    '',
    'Produis le JSON `operations[]` pour mettre à jour les pages dont les recherches contredisent / précisent l\'info actuelle. Toute page actualisée doit lister les URLs consultées dans `frontmatter.sources` et ajouter `modifié: <date ISO>`. Si une recherche n\'a rien apporté de probant, ne touche pas à la page correspondante.'
  ].join('\n\n')
}

// Parse le JSON Phase 1 en étant tolérant au bruit (markdown fence,
// préambule, etc.).
function parsePhase1Queries(raw: string): Phase1Query[] {
  const json = stripFences(raw).trim()
  const match = json.match(/\{[\s\S]*\}/)
  const candidate = match ? match[0] : json
  try {
    const parsed = JSON.parse(candidate) as { queries?: Phase1Query[] }
    if (!parsed.queries || !Array.isArray(parsed.queries)) return []
    return parsed.queries
      .filter((q) => q && typeof q.query === 'string' && q.query.trim().length > 0)
      .map((q) => ({
        page: typeof q.page === 'string' ? q.page : '(non spécifié)',
        field: typeof q.field === 'string' ? q.field : '(non spécifié)',
        query: q.query.trim()
      }))
  } catch (e) {
    console.warn('[researcher] parse phase 1 échoué :', e, raw.slice(0, 500))
    return []
  }
}

interface ParsedOp {
  op: string
  filename: string
  content: string
  reason?: string
}

function parseOperations(raw: string): { operations: ParsedOp[]; logEntry: string | null } {
  const json = stripFences(raw).trim()
  const match = json.match(/\{[\s\S]*\}/)
  const candidate = match ? match[0] : json
  try {
    const parsed = JSON.parse(candidate) as {
      operations?: ParsedOp[]
      logEntry?: string
    }
    return {
      operations: Array.isArray(parsed.operations)
        ? parsed.operations.filter(
            (o) => o && typeof o.op === 'string' && typeof o.filename === 'string' && typeof o.content === 'string'
          )
        : [],
      logEntry: typeof parsed.logEntry === 'string' ? parsed.logEntry : null
    }
  } catch (e) {
    console.warn('[researcher] parse phase 2 échoué :', e, raw.slice(0, 500))
    return { operations: [], logEntry: null }
  }
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
}

function stripWikiPrefix(filename: string): string {
  let s = filename.replace(/\\/g, '/').trim()
  if (s.startsWith('./')) s = s.slice(2)
  if (s.startsWith('/')) s = s.slice(1)
  if (s.startsWith('wiki/')) s = s.slice(5)
  return s
}
