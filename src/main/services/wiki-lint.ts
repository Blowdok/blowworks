import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as wiki from './wiki-fs.js'
import { buildWikiGraphData } from './wiki-graph.js'
import { oneShotChat } from './openrouter.js'
import type { AgentT } from '@shared/ipc-contract.js'

// Agent Lint (Sprint 4) — pattern Karpathy LLM Wiki "lint = test suite".
// 6 checks déterministes en TypeScript (gratuits, instantanés) + 1 check
// LLM pour les contradictions factuelles entre pages. Produit un rapport
// markdown dans `audit/YYYY-MM-DD.md` et retourne un résumé.
//
// Les checks déterministes se font sur le graph data déjà construit
// par `buildWikiGraphData` + un parsing léger du frontmatter. Aucun
// appel LLM pour ces 6 checks → coût = 0, latence = millisecondes.
// Le 7e check (contradictions) fait UN seul appel LLM avec format
// de sortie machine-parseable (`NO_ISSUES` ou `CONTRADICTION: ...`)
// pour limiter les hallucinations.

export type LintSeverity = 'low' | 'medium' | 'high'
export type LintKind =
  | 'orphan'
  | 'broken-ref'
  | 'ghost-concept'
  | 'stale'
  | 'sparse'
  | 'orphan-source'
  | 'contradiction'
  | 'inconsistency'

export interface LintIssue {
  kind: LintKind
  severity: LintSeverity
  pages: string[] // chemins relatifs wiki/
  description: string
}

export interface LintReport {
  runAt: number
  scanned: number
  issues: LintIssue[]
  summary: string
}

// Seuils d'heuristiques — ajustables via setting futur si besoin.
const STALE_DAYS = 60
const SPARSE_MIN_WORDS = 200
const SPARSE_MIN_WIKILINKS = 2
const GHOST_CONCEPT_MIN_MENTIONS = 3
const GHOST_CONCEPT_MIN_LENGTH = 4

export async function runWikiLint(agent: AgentT | null): Promise<LintReport> {
  const status = await wiki.getWikiStatus()
  if (!status.initialized) {
    throw new Error('Wiki non configuré — ouvre Settings > Wiki.')
  }

  // Source 1 : graph data (nodes/edges avec backlinks, outlinks, types).
  const graph = await buildWikiGraphData()

  // Source 2 : contenu complet + frontmatter léger de chaque page pour
  // les checks qui ont besoin du corps (sparse, stale, orphan-source).
  const wikiEntries = await wiki.listWiki()
  const pages = await Promise.all(
    wikiEntries.map(async (e) => {
      try {
        const content = await wiki.readWiki(e.name)
        return {
          name: e.name,
          content,
          size: e.size,
          modifiedAt: e.modifiedAt,
          frontmatter: parseFrontmatterLite(content)
        }
      } catch {
        return null
      }
    })
  )
  const validPages = pages.filter((p): p is NonNullable<typeof p> => p !== null)

  // Source 3 : liste des raw existants pour check `orphan-source`.
  const rawEntries = await wiki.listRaw()
  const rawSet = new Set(rawEntries.map((e) => `raw/${e.name}`))

  const issues: LintIssue[] = []

  // ─── Check 1 : orphans (pages sans aucun backlink)
  const wikiTotalPages = graph.nodes.length
  for (const node of graph.nodes) {
    if (node.backlinks === 0 && wikiTotalPages > 5) {
      // Les index/concepts piliers peuvent être orphelins légitimement —
      // sévérité basse plutôt que high.
      issues.push({
        kind: 'orphan',
        severity: node.importance === 'pilier' ? 'low' : 'medium',
        pages: [node.id],
        description: `Page sans backlink. Aucune autre page ne la référence via [[…]].`
      })
    }
  }

  // ─── Check 2 : broken-refs (wikilinks vers pages inexistantes)
  for (const edge of graph.edges) {
    if (edge.target === null) {
      issues.push({
        kind: 'broken-ref',
        severity: 'high',
        pages: [edge.source],
        description: `Wikilink brisé : [[${edge.targetSlug}]] ne résout vers aucune page existante.`
      })
    }
  }

  // ─── Check 3 : ghost-concepts (mots/titres répétés sans page dédiée)
  // Heuristique : un terme qui apparaît `GHOST_CONCEPT_MIN_MENTIONS`+
  // fois dans le corps de plusieurs pages, long ≥ `GHOST_CONCEPT_MIN_LENGTH`
  // caractères, capitalisation cohérente, et qui n'est PAS déjà un nom
  // de page existant → candidat à transformation en concept propre.
  const pageNames = new Set(graph.nodes.map((n) => basename(n.id).replace(/\.md$/, '')))
  const termCounts = new Map<string, Set<string>>() // term → set of pages
  for (const p of validPages) {
    // Strip frontmatter + code fences pour compter uniquement les mots de prose.
    const body = stripFrontmatter(p.content).replace(/```[\s\S]*?```/g, '')
    // Capture les mots en Capitalized-Kebab-Case (PascalCase-like) qui sont
    // souvent des concepts nommés : "Supabase", "React Native", "Pagemark".
    const matches = body.match(/\b[A-ZÉÈÀ][a-zà-ÿ]{2,}(?:[- ][A-ZÉÈÀ][a-zà-ÿ]{2,})*\b/g) ?? []
    for (const term of matches) {
      const normalized = term.toLowerCase().replace(/\s+/g, '-')
      if (normalized.length < GHOST_CONCEPT_MIN_LENGTH) continue
      if (pageNames.has(normalized)) continue
      const set = termCounts.get(normalized) ?? new Set<string>()
      set.add(p.name)
      termCounts.set(normalized, set)
    }
  }
  for (const [term, occurringPages] of termCounts) {
    if (occurringPages.size >= GHOST_CONCEPT_MIN_MENTIONS) {
      issues.push({
        kind: 'ghost-concept',
        severity: 'low',
        pages: Array.from(occurringPages).slice(0, 10),
        description: `Le terme "${term}" apparaît dans ${occurringPages.size} pages sans avoir sa propre page. Envisage de créer \`concepts/${term}.md\`.`
      })
    }
  }

  // ─── Check 4 : stale (statut to-verify depuis > STALE_DAYS jours)
  const staleCutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000
  for (const p of validPages) {
    if (p.frontmatter.statut === 'to-verify' && p.modifiedAt < staleCutoff) {
      const days = Math.round((Date.now() - p.modifiedAt) / (24 * 60 * 60 * 1000))
      issues.push({
        kind: 'stale',
        severity: 'medium',
        pages: [p.name],
        description: `Page marquée \`statut: to-verify\` non modifiée depuis ${days} jours. Relis-la et bascule vers \`verified\` ou corrige.`
      })
    }
  }

  // ─── Check 5 : sparse (pages trop courtes ou sans wikilinks)
  // Applique seulement si le wiki a > 5 pages (pas la peine de crier
  // sur un wiki de démarrage).
  if (wikiTotalPages > 5) {
    for (const p of validPages) {
      const body = stripFrontmatter(p.content)
      const words = body.split(/\s+/).filter((w) => w.length > 0).length
      const node = graph.nodes.find((n) => n.id === p.name)
      const outlinks = node?.outlinks ?? 0
      if (words < SPARSE_MIN_WORDS) {
        issues.push({
          kind: 'sparse',
          severity: 'low',
          pages: [p.name],
          description: `Page courte : ${words} mots (< ${SPARSE_MIN_WORDS}). Enrichis le contenu ou fusionne avec un concept proche.`
        })
      } else if (outlinks < SPARSE_MIN_WIKILINKS) {
        issues.push({
          kind: 'sparse',
          severity: 'low',
          pages: [p.name],
          description: `Page peu connectée : ${outlinks} wikilink(s) sortant(s) (< ${SPARSE_MIN_WIKILINKS}). Ajoute des [[liens]] vers des concepts voisins.`
        })
      }
    }
  }

  // ─── Check 6 : orphan-sources (sources: pointe vers raw absent)
  for (const p of validPages) {
    const sources = p.frontmatter.sources ?? []
    for (const src of sources) {
      if (!rawSet.has(src)) {
        issues.push({
          kind: 'orphan-source',
          severity: 'medium',
          pages: [p.name],
          description: `La source \`${src}\` référencée dans le frontmatter n'existe plus dans raw/. Le raw a-t-il été supprimé ?`
        })
      }
    }
  }

  // ─── Check 7 (LLM) : contradictions factuelles entre pages
  // Fait UN seul appel avec format strict NO_ISSUES / CONTRADICTION/INCONSISTENCY.
  // Skip si agent désactivé ou absent (permet de lancer juste les 6
  // checks déterministes gratuitement).
  if (agent && agent.enabled && validPages.length >= 2) {
    try {
      const contradictions = await runContradictionCheck(agent, validPages)
      issues.push(...contradictions)
    } catch (e) {
      console.warn('[wiki-lint] check contradictions échoué :', e)
    }
  }

  const summary = buildSummary(validPages.length, issues)
  const report: LintReport = {
    runAt: Date.now(),
    scanned: validPages.length,
    issues,
    summary
  }

  await writeReportMarkdown(report)

  return report
}

// ──────────────────────────────────────────────────────────── Safe-fixable subset

// Ré-exécute uniquement les 2 checks "safe à auto-fix" (broken-ref et
// orphan-source) pour injection dans le prompt du Wiki Builder. Gratuit
// (pas d'appel LLM), <200 ms. Le WB tente de corriger ces issues pendant
// une reconstruction standard — pas de nouvel agent à orchestrer.
//
// Pourquoi SEULEMENT ces 2 types :
//   - `broken-ref` : wikilink `[[xxx]]` sans cible. Correction mécanique
//     (remplacer par la bonne cible si identifiable, sinon laisser).
//   - `orphan-source` : entrée `sources: [raw/xxx]` dans un frontmatter
//     alors que le raw a été supprimé. Correction : retirer l'entrée.
//
// Les autres issues (orphan, ghost-concept, stale, sparse, contradictions)
// demandent un jugement éditorial → risque de suppression/fusion agressive.
// On les laisse à l'humain (ou à un futur agent `lint_fixer` dédié).
export async function findSafeFixableIssues(): Promise<LintIssue[]> {
  const status = await wiki.getWikiStatus()
  if (!status.initialized) return []

  const graph = await buildWikiGraphData()
  const issues: LintIssue[] = []

  // Check broken-ref : wikilinks sans cible résolue.
  for (const edge of graph.edges) {
    if (edge.target === null) {
      issues.push({
        kind: 'broken-ref',
        severity: 'high',
        pages: [edge.source],
        description: `Wikilink brisé : [[${edge.targetSlug}]] ne résout vers aucune page existante.`
      })
    }
  }

  // Check orphan-source : raw/ disparus mais toujours listés en frontmatter.
  const [wikiEntries, rawEntries] = await Promise.all([wiki.listWiki(), wiki.listRaw()])
  const rawSet = new Set(rawEntries.map((e) => `raw/${e.name}`))
  for (const entry of wikiEntries) {
    try {
      const content = await wiki.readWiki(entry.name)
      const fm = parseFrontmatterLite(content)
      for (const src of fm.sources ?? []) {
        if (!rawSet.has(src)) {
          issues.push({
            kind: 'orphan-source',
            severity: 'medium',
            pages: [entry.name],
            description: `La source \`${src}\` référencée dans le frontmatter n'existe plus dans raw/.`
          })
        }
      }
    } catch {
      /* skip la page illisible */
    }
  }

  return issues
}

// ──────────────────────────────────────────────────────────── Check 7 (LLM)

async function runContradictionCheck(
  agent: AgentT,
  pages: Array<{ name: string; content: string }>
): Promise<LintIssue[]> {
  const userPrompt = [
    '## Pages à auditer',
    '',
    pages.map((p) => `### wiki/${p.name}\n\n${p.content}`).join('\n\n---\n\n')
  ].join('\n\n')

  const result = await oneShotChat({
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    userPrompt,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens
  })
  if (result.error) {
    throw new Error(`Échec check contradictions : ${result.error}`)
  }

  const text = result.content.trim()
  if (text === 'NO_ISSUES' || text.startsWith('NO_ISSUES')) return []

  const issues: LintIssue[] = []
  for (const line of text.split(/\r?\n/)) {
    const issue = parseLintLine(line)
    if (issue) issues.push(issue)
    // Lignes non-parseables : ignorées (le modèle a dévié du format).
  }
  return issues
}

// Parse une ligne de lint. Deux formats supportés :
//
// Ancien (prompt V1) :
//   CONTRADICTION: wiki/A vs wiki/B - description
//   INCONSISTENCY: wiki/A - description
//
// Nouveau (prompt V2+) :
//   CONTRADICTION[HIGH|LOW]: wiki/A#heading vs wiki/B#heading | claim-a: "..." | claim-b: "..." | angle: <dates|chiffres|...>
//   INCONSISTENCY[HIGH|LOW]: wiki/A#heading | description | angle: <...>
//
// Dans les deux cas on strip `wiki/` et `#heading` des paths, et on
// synthétise une description lisible à partir des champs présents.
function parseLintLine(rawLine: string): LintIssue | null {
  const trimmed = rawLine.trim()
  if (!trimmed) return null

  // Détecte type + severity optionnelle (défaut HIGH pour contradiction,
  // MEDIUM pour inconsistency). Groupe 1 = type, groupe 2 = severity.
  const prefix = trimmed.match(/^(CONTRADICTION|INCONSISTENCY)(?:\[(HIGH|LOW|MEDIUM)\])?\s*:\s*(.*)$/i)
  if (!prefix) return null

  const kind = prefix[1].toLowerCase() === 'contradiction' ? 'contradiction' : 'inconsistency'
  const severityTag = prefix[2]?.toUpperCase()
  const rest = prefix[3]

  // Sépare le segment "paths" du segment "description/claims/angle".
  // Le séparateur est le PREMIER `|` (nouveau format) ou ` - ` (ancien).
  // Note : on évite de splitter sur un `-` dans un claim, donc on cherche
  // ` - ` avec espaces autour (uniquement l'ancien format).
  let pathsPart: string
  let tailPart: string
  const pipeIdx = rest.indexOf('|')
  const dashSepIdx = rest.search(/\s+-\s+/)
  if (pipeIdx >= 0 && (dashSepIdx < 0 || pipeIdx < dashSepIdx)) {
    pathsPart = rest.slice(0, pipeIdx).trim()
    tailPart = rest.slice(pipeIdx + 1).trim()
  } else if (dashSepIdx >= 0) {
    pathsPart = rest.slice(0, dashSepIdx).trim()
    tailPart = rest.replace(/^.*?\s+-\s+/, '').trim()
  } else {
    // Format sans description : juste les paths.
    pathsPart = rest.trim()
    tailPart = ''
  }

  if (kind === 'contradiction') {
    // paths : "wiki/A#h vs wiki/B#h"
    const m = pathsPart.match(/^(?:wiki\/)?(\S+?)\s+vs\s+(?:wiki\/)?(\S+)$/i)
    if (!m) return null
    const pageA = stripHeading(m[1])
    const pageB = stripHeading(m[2])
    const description = buildDescriptionFromTail(tailPart) || 'Contradiction détectée'
    const severity: LintSeverity =
      severityTag === 'LOW' ? 'low' : 'high'
    return {
      kind: 'contradiction',
      severity,
      pages: [pageA, pageB],
      description
    }
  }

  // inconsistency : paths = "wiki/A#h"
  const pageA = stripHeading(pathsPart.replace(/^wiki\//, ''))
  const description = buildDescriptionFromTail(tailPart) || 'Incohérence détectée'
  const severity: LintSeverity = severityTag === 'HIGH' ? 'high' : severityTag === 'LOW' ? 'low' : 'medium'
  return {
    kind: 'inconsistency',
    severity,
    pages: [pageA],
    description
  }
}

// Retire une éventuelle ancre `#heading` d'un chemin `foo/bar.md#section`.
function stripHeading(pathWithHash: string): string {
  const hashIdx = pathWithHash.indexOf('#')
  return hashIdx >= 0 ? pathWithHash.slice(0, hashIdx) : pathWithHash
}

// Reconstruit une description lisible depuis le tail — soit un simple
// texte (ancien format), soit une série de pipes `| claim-a: "..." |
// claim-b: "..." | angle: ...` (nouveau format).
function buildDescriptionFromTail(tail: string): string {
  if (!tail) return ''
  // Si pas de structure pipe, c'est une description plate → renvoyer tel quel.
  if (!tail.includes('|') && !/(claim-a|claim-b|angle)\s*:/i.test(tail)) {
    return tail.trim()
  }
  // Parse les segments "key: value" séparés par `|`.
  const parts: Record<string, string> = {}
  for (const chunk of tail.split('|')) {
    const m = chunk.trim().match(/^(claim-a|claim-b|angle|description)\s*:\s*(.*)$/i)
    if (!m) continue
    parts[m[1].toLowerCase()] = m[2].trim().replace(/^"(.*)"$/, '$1')
  }
  const bits: string[] = []
  if (parts['claim-a'] && parts['claim-b']) {
    bits.push(`A: "${parts['claim-a']}" vs B: "${parts['claim-b']}"`)
  } else if (parts.description) {
    bits.push(parts.description)
  } else if (parts['claim-a']) {
    bits.push(parts['claim-a'])
  }
  if (parts.angle) bits.push(`(angle: ${parts.angle})`)
  return bits.join(' ').trim() || tail.trim()
}

// ──────────────────────────────────────────────────────────── Report markdown

async function writeReportMarkdown(report: LintReport): Promise<void> {
  const folder = (await wiki.getWikiStatus()).folderPath
  if (!folder) return

  const auditDir = path.join(folder, 'audit')
  await fs.mkdir(auditDir, { recursive: true })

  const date = new Date(report.runAt).toISOString().slice(0, 10)
  const time = new Date(report.runAt).toISOString().slice(0, 19).replace(/:/g, '-')
  const filename = `lint-${time}.md`
  const filePath = path.join(auditDir, filename)

  const byKind = new Map<LintKind, LintIssue[]>()
  for (const issue of report.issues) {
    const arr = byKind.get(issue.kind) ?? []
    arr.push(issue)
    byKind.set(issue.kind, arr)
  }

  const kindLabels: Record<LintKind, string> = {
    orphan: 'Pages orphelines',
    'broken-ref': 'Wikilinks brisés',
    'ghost-concept': 'Concepts fantômes',
    stale: 'Pages périmées',
    sparse: 'Pages peu étoffées',
    'orphan-source': 'Sources raw disparues',
    contradiction: 'Contradictions factuelles',
    inconsistency: 'Incohérences'
  }

  const lines: string[] = [
    `# Rapport Lint — ${date}`,
    '',
    `Scanné : ${report.scanned} pages · ${report.issues.length} issue${report.issues.length > 1 ? 's' : ''}`,
    '',
    report.summary,
    ''
  ]

  for (const kind of [
    'broken-ref',
    'contradiction',
    'stale',
    'orphan-source',
    'orphan',
    'inconsistency',
    'ghost-concept',
    'sparse'
  ] as LintKind[]) {
    const issuesForKind = byKind.get(kind)
    if (!issuesForKind || issuesForKind.length === 0) continue
    lines.push(`## ${kindLabels[kind]} (${issuesForKind.length})`)
    lines.push('')
    for (const issue of issuesForKind) {
      const sev = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢'
      lines.push(`- ${sev} **${issue.pages.join(' / ')}** — ${issue.description}`)
    }
    lines.push('')
  }

  if (report.issues.length === 0) {
    lines.push('Aucune issue détectée. Le wiki est propre.', '')
  }

  await fs.writeFile(filePath, lines.join('\n'), 'utf8')

  // Append au log principal pour audit trail.
  const iso = new Date(report.runAt).toISOString()
  await wiki.appendLog(
    `## [${iso}] lint | ${report.issues.length} issue${report.issues.length > 1 ? 's' : ''} sur ${report.scanned} pages → audit/${filename}\n`
  )
}

function buildSummary(scanned: number, issues: LintIssue[]): string {
  if (issues.length === 0) return `✅ Aucun problème détecté sur ${scanned} pages.`
  const bySev: Record<LintSeverity, number> = { high: 0, medium: 0, low: 0 }
  for (const issue of issues) bySev[issue.severity]++
  const parts: string[] = []
  if (bySev.high > 0) parts.push(`${bySev.high} critique${bySev.high > 1 ? 's' : ''}`)
  if (bySev.medium > 0) parts.push(`${bySev.medium} moyen${bySev.medium > 1 ? 's' : ''}`)
  if (bySev.low > 0) parts.push(`${bySev.low} info${bySev.low > 1 ? 's' : ''}`)
  return `Sur ${scanned} pages : ${parts.join(' · ')}.`
}

// ──────────────────────────────────────────────────────────── Helpers

interface LiteFrontmatter {
  statut?: string
  sources?: string[]
}

function parseFrontmatterLite(content: string): LiteFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const yaml = match[1]
  const out: LiteFrontmatter = {}
  for (const line of yaml.split(/\r?\n/)) {
    const statutMatch = line.match(/^statut:\s*(.+?)\s*$/)
    if (statutMatch) {
      out.statut = statutMatch[1].replace(/^["']|["']$/g, '')
      continue
    }
    // Array inline : sources: ["raw/a.md", "raw/b.md"]
    const sourcesInline = line.match(/^sources:\s*\[(.+)\]\s*$/)
    if (sourcesInline) {
      out.sources = sourcesInline[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0)
    }
  }
  return out
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}
