import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as wiki from './wiki-fs.js'
import type { ToolCall, ToolResult } from '@shared/ai-tool-schemas.js'

// Service d'exécution des tools wiki (pattern nexusvault_v4 `executeAgentTool`).
// Chaque tool :
//   - valide ses args (types, bornes)
//   - délègue aux helpers wiki-fs existants (sandbox path traversal déjà là)
//   - tronque les retours pour ne pas saturer le prochain prompt
//   - retourne { result: string } OU { result: '', error: string }
//
// Les erreurs REMONTENT au modèle sous forme de tool_result. Pas de throw —
// ça permettrait au LLM de corriger (ex: chemin inexistant → il liste,
// puis retente avec le bon nom).

// Limites côté résultat pour éviter les blowups de contexte :
//   - read_wiki_page / read_schema / read_index : 40 000 chars (tronqué)
//   - search_wiki : max 50 correspondances
//   - list_wiki_pages : pas de limite (les listes restent petites <1000 entrées)
//   - write : max 1 MB en entrée (contrôle côté runner)
const MAX_READ_CHARS = 40_000
const MAX_SEARCH_HITS = 50
const MAX_WRITE_BYTES = 1_000_000

export async function executeAiTool(call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case 'read_wiki_page':
        return await readWikiPage(call)
      case 'list_wiki_pages':
        return await listWikiPages(call)
      case 'search_wiki':
        return await searchWiki(call)
      case 'read_wiki_schema':
        return await readWikiSchema(call)
      case 'read_wiki_index':
        return await readWikiIndex(call)
      case 'write_wiki_page':
        return await writeWikiPage(call)
      case 'rename_wiki_page':
        return await renameWikiPage(call)
      case 'delete_wiki_page':
        return await deleteWikiPage(call)
      default:
        return { id: call.id, result: '', error: `Tool inconnu : ${call.name}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { id: call.id, result: '', error: msg }
  }
}

// ──────────────────────────────────────────────────────────── Read tools

function argString(call: ToolCall, key: string): string {
  const v = call.arguments[key]
  if (typeof v !== 'string') {
    throw new Error(`Argument \`${key}\` manquant ou non-string pour ${call.name}.`)
  }
  return v
}

async function readWikiPage(call: ToolCall): Promise<ToolResult> {
  const name = argString(call, 'name')
  const content = await wiki.readWiki(name)
  return { id: call.id, result: truncate(content, MAX_READ_CHARS, name) }
}

async function listWikiPages(call: ToolCall): Promise<ToolResult> {
  const subdir = typeof call.arguments.subdir === 'string' ? call.arguments.subdir : null
  const all = await wiki.listWiki()
  const filtered = subdir ? all.filter((e) => e.name.startsWith(subdir + '/')) : all
  if (filtered.length === 0) {
    return {
      id: call.id,
      result: subdir
        ? `Aucune page dans wiki/${subdir}/.`
        : 'Le wiki est vide.'
    }
  }
  const lines = filtered.map(
    (e) => `- ${e.name}  (${formatBytes(e.size)}, modifié ${new Date(e.modifiedAt).toISOString().slice(0, 10)})`
  )
  return { id: call.id, result: `${filtered.length} page(s) :\n${lines.join('\n')}` }
}

async function searchWiki(call: ToolCall): Promise<ToolResult> {
  const pattern = argString(call, 'pattern')
  const flags = typeof call.arguments.flags === 'string' ? call.arguments.flags : 'gi'
  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { id: call.id, result: '', error: `Regex invalide : ${msg}` }
  }

  const hits: string[] = []
  const entries = await wiki.listWiki()
  for (const entry of entries) {
    if (hits.length >= MAX_SEARCH_HITS) break
    try {
      const content = await wiki.readWiki(entry.name)
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= MAX_SEARCH_HITS) break
        // Reset lastIndex sur le regex global pour chaque ligne
        regex.lastIndex = 0
        if (regex.test(lines[i])) {
          const snippet = lines[i].slice(0, 200).replace(/\s+/g, ' ').trim()
          hits.push(`${entry.name}:${i + 1}: ${snippet}`)
        }
      }
    } catch {
      // fichier illisible — ignore et continue
    }
  }
  if (hits.length === 0) {
    return {
      id: call.id,
      result: `Aucune correspondance pour /${pattern}/${flags} dans le wiki.`
    }
  }
  const header =
    hits.length === MAX_SEARCH_HITS
      ? `${MAX_SEARCH_HITS}+ correspondances (liste tronquée) :\n`
      : `${hits.length} correspondance(s) :\n`
  return { id: call.id, result: header + hits.join('\n') }
}

async function readWikiSchema(call: ToolCall): Promise<ToolResult> {
  const content = await wiki.readSchema()
  if (content == null) {
    return {
      id: call.id,
      result: '',
      error: 'SCHEMA.md absent ou wiki non configuré.'
    }
  }
  return { id: call.id, result: truncate(content, MAX_READ_CHARS, 'SCHEMA.md') }
}

async function readWikiIndex(call: ToolCall): Promise<ToolResult> {
  const content = await wiki.readIndex()
  if (content == null) {
    return {
      id: call.id,
      result: '',
      error: 'index.md absent ou wiki non configuré.'
    }
  }
  return { id: call.id, result: truncate(content, MAX_READ_CHARS, 'wiki/index.md') }
}

// ──────────────────────────────────────────────────────────── Write tools (confirmation)

async function writeWikiPage(call: ToolCall): Promise<ToolResult> {
  const name = argString(call, 'name')
  const content = argString(call, 'content')
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    return {
      id: call.id,
      result: '',
      error: `Contenu trop gros (${content.length} chars, max ~${MAX_WRITE_BYTES}).`
    }
  }
  await wiki.writeWiki(name, content)
  return {
    id: call.id,
    result: `OK — ${name} écrit (${content.length.toLocaleString('fr-FR')} caractères).`
  }
}

async function renameWikiPage(call: ToolCall): Promise<ToolResult> {
  const from = argString(call, 'from')
  const to = argString(call, 'to')
  await wiki.renameWiki(from, to)
  return { id: call.id, result: `OK — ${from} → ${to}.` }
}

async function deleteWikiPage(call: ToolCall): Promise<ToolResult> {
  const name = argString(call, 'name')
  await wiki.deleteWiki(name)
  return { id: call.id, result: `OK — ${name} supprimé.` }
}

// ──────────────────────────────────────────────────────────── Helpers

function truncate(s: string, max: number, label: string): string {
  if (s.length <= max) return s
  return (
    s.slice(0, max) +
    `\n\n…[${label} tronqué à ${max} caractères sur ${s.length.toLocaleString('fr-FR')} — demande une section précise si besoin]`
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Reserved for future use (explicit path validation outside wiki-fs).
// Conservé pour montrer l'intent : si on ajoute un tool qui lit hors du
// dossier wiki (ex: lecture d'un log), ce helper garantit le sandbox.
export function sandboxWikiPath(base: string, rel: string): string {
  if (typeof rel !== 'string' || rel === '') {
    throw new Error('Chemin vide.')
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`Chemin absolu interdit : ${rel}`)
  }
  const normalized = path.normalize(rel).replace(/\\/g, '/')
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`Traversée de chemin interdite : ${rel}`)
  }
  const resolved = path.resolve(base, normalized)
  const baseReal = path.resolve(base)
  if (resolved !== baseReal && !resolved.startsWith(baseReal + path.sep)) {
    throw new Error(`Chemin hors du dossier wiki : ${rel}`)
  }
  return resolved
}

// fs est importé pour permettre à de futurs tools (ex: read_fact_check_log)
// d'accéder directement au FS via sandboxWikiPath. Non utilisé actuellement.
void fs
