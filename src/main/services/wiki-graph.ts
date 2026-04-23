import * as wiki from './wiki-fs.js'
import type { WikiGraphDataT, WikiGraphNodeT, WikiGraphEdgeT } from '@shared/ipc-contract.js'

// Construit le graphe du wiki à partir des fichiers wiki/*.md :
//   - Chaque page = 1 nœud (id = chemin relatif `concepts/pagemark.md`).
//   - Chaque `[[wikilink]]` = 1 arête (source → target résolu).
//   - Frontmatter YAML lu sans dépendance : on parse juste les 5 champs
//     utiles (titre, type, importance, statut, liens_forts) via regex.
//     Suffit pour la visualisation, inutile d'ajouter gray-matter.
//
// Résolution des wikilinks : `[[pagemark]]` → cherche dans l'ordre
//   1. `concepts/pagemark.md` (convention par défaut)
//   2. `connections/pagemark.md`
//   3. `qa/pagemark.md`
//   4. racine `pagemark.md`
//   5. n'importe quel dossier qui matche le basename (dernier recours)
// Les liens non résolus deviennent des arêtes orphelines (target = null
// côté renderer) qu'on peut afficher en pointillé.
//
// Sans tri explicite côté renderer, les arêtes sont dédupliquées (A→B
// apparaît une seule fois même si A cite B plusieurs fois).

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g

export async function buildWikiGraphData(): Promise<WikiGraphDataT> {
  const status = await wiki.getWikiStatus()
  if (!status.initialized) {
    return { nodes: [], edges: [] }
  }
  const entries = await wiki.listWiki()
  if (entries.length === 0) {
    return { nodes: [], edges: [] }
  }

  // Map basename → chemin canonique pour la résolution des wikilinks.
  // Priorité : chemin explicite > concepts/ > connections/ > qa/ > racine.
  const byBasename = new Map<string, string>()
  for (const e of entries) {
    const basename = e.name.slice(e.name.lastIndexOf('/') + 1).replace(/\.md$/, '')
    const existing = byBasename.get(basename)
    if (!existing || priority(e.name) > priority(existing)) {
      byBasename.set(basename, e.name)
    }
  }

  const nodes: WikiGraphNodeT[] = []
  const rawEdges: Array<{ source: string; targetSlug: string }> = []

  for (const entry of entries) {
    let content: string
    try {
      content = await wiki.readWiki(entry.name)
    } catch {
      continue
    }
    const frontmatter = parseFrontmatterLite(content)

    // Compte les backlinks plus tard — pour l'instant on crée le nœud.
    nodes.push({
      id: entry.name,
      title: frontmatter.titre ?? basename(entry.name),
      type: frontmatter.type ?? inferTypeFromPath(entry.name),
      importance: frontmatter.importance ?? 'standard',
      statut: frontmatter.statut ?? 'verified',
      backlinks: 0,
      outlinks: 0
    })

    // Scan `[[wikilinks]]` dans le corps. Evite les blocs code triple
    // backtick (les `[[liens]]` dans du code ne sont pas des wikilinks).
    const bodyOnly = stripCodeFences(content)
    const found = new Set<string>()
    for (const match of bodyOnly.matchAll(WIKILINK_RE)) {
      const slug = match[1].trim()
      if (!slug || slug === basename(entry.name).replace(/\.md$/, '')) continue
      found.add(slug)
    }
    for (const slug of found) {
      rawEdges.push({ source: entry.name, targetSlug: slug })
    }
  }

  // Résolution des targetSlug → chemin canonique + comptage backlinks.
  const edges: WikiGraphEdgeT[] = []
  const seenPair = new Set<string>() // "source||target" pour dédup
  for (const re of rawEdges) {
    const target = resolveSlug(re.targetSlug, byBasename)
    const key = `${re.source}||${target ?? `?${re.targetSlug}`}`
    if (seenPair.has(key)) continue
    seenPair.add(key)
    edges.push({ source: re.source, target, targetSlug: re.targetSlug })

    const src = nodes.find((n) => n.id === re.source)
    if (src) src.outlinks++
    if (target) {
      const dst = nodes.find((n) => n.id === target)
      if (dst) dst.backlinks++
    }
  }

  return { nodes, edges }
}

// ──────────────────────────────────────────────────────────── Helpers

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

// Priorité d'un chemin pour la résolution `[[slug]]` par basename.
// Plus la valeur est haute, plus le chemin est "standard".
function priority(p: string): number {
  if (p.startsWith('concepts/')) return 4
  if (p.startsWith('connections/')) return 3
  if (p.startsWith('qa/')) return 2
  if (!p.includes('/')) return 1 // racine
  return 0
}

// Infère un type depuis le dossier (fallback si frontmatter absent).
function inferTypeFromPath(p: string): string {
  if (p.startsWith('concepts/')) return 'concept'
  if (p.startsWith('connections/')) return 'connection'
  if (p.startsWith('qa/')) return 'qa'
  return 'concept'
}

// Résolution d'un slug `[[xxx]]` vers un chemin canonique.
// 1. Si le slug contient '/', on tente d'abord comme chemin explicite
//    (avec/sans .md).
// 2. Sinon, lookup par basename dans la map.
function resolveSlug(slug: string, byBasename: Map<string, string>): string | null {
  const trimmed = slug.trim()
  if (trimmed.includes('/')) {
    const withExt = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
    // Priorité au match exact. Sinon fallback basename.
    for (const v of byBasename.values()) if (v === withExt) return withExt
  }
  const bareSlug = trimmed.replace(/\.md$/, '').split('/').pop()!
  return byBasename.get(bareSlug) ?? null
}

// Parser léger du frontmatter YAML (5 champs). Pas de dépendance à
// gray-matter. Tolère l'absence de frontmatter (retourne {}).
interface LiteFrontmatter {
  titre?: string
  type?: string
  importance?: string
  statut?: string
}

function parseFrontmatterLite(content: string): LiteFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const yaml = match[1]
  const out: LiteFrontmatter = {}
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^(titre|type|importance|statut):\s*(.+?)\s*$/)
    if (!m) continue
    const key = m[1] as keyof LiteFrontmatter
    // Retire guillemets simples/doubles éventuels.
    const value = m[2].replace(/^["']|["']$/g, '')
    out[key] = value
  }
  return out
}

function stripCodeFences(s: string): string {
  return s.replace(/```[\s\S]*?```/g, '')
}
