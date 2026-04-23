import { promises as fs } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { getDb } from './db.js'
import type { WikiFolderStatusT, WikiEntryT } from '@shared/ipc-contract.js'

// Service FS pour la « mémoire long-terme » de BlowWorks (pattern Karpathy
// LLM Wiki). Tout l'état persistant vit dans un dossier choisi par
// l'utilisateur :
//
//   <wikiFolder>/
//     ├─ raw/          synthèses horodatées (agent Synthétiseur)
//     ├─ wiki/         pages structurées (agent Wiki Builder)
//     └─ MEMORY.md     conventions que les agents doivent respecter
//
// Settings SQLite :
//   - `wiki.folderPath`  : chemin absolu ou absent
//   - `wiki.initialized` : '1' une fois la structure créée
//
// Onboarding paresseux : rien n'est fait au boot. L'utilisateur ouvre
// Settings > Wiki pour choisir un dossier. Tous les handlers `list/read/write`
// vérifient d'abord que le dossier est configuré — sinon ils retournent un
// état neutre (listes vides, null) plutôt que de throw, pour que les
// appelants (agents futurs) puissent no-op silencieusement.

const SETTINGS_FOLDER_KEY = 'wiki.folderPath'
const SETTINGS_INITIALIZED_KEY = 'wiki.initialized'
const RAW_DIR = 'raw'
const WIKI_DIR = 'wiki'
const MEMORY_FILENAME = 'MEMORY.md'

// Template bootstrap du MEMORY.md — généré UNE FOIS à l'init, éditable
// ensuite par l'utilisateur. Décrit les conventions que les agents Wiki
// Builder et Synthétiseur doivent respecter (lot 3).
const MEMORY_TEMPLATE = `# Mémoire IA — Wiki BlowWorks

Ce dossier est la mémoire long-terme partagée entre toutes les conversations IA.

## Structure

- \`raw/\` : synthèses horodatées des conversations (input brut, non curé).
- \`wiki/\` : pages structurées maintenues par l'agent Wiki Builder, reliées par \`[[wiki-links]]\`.
- \`MEMORY.md\` : ce fichier. Décrit les conventions que les agents doivent respecter.

## Conventions

- Les pages wiki sont nommées en \`kebab-case.md\`.
- Les liens inter-pages utilisent \`[[nom-page]]\`.
- Une page = un concept/sujet (projet, personne, décision, référence technique).
- Le Wiki Builder a le droit de fusionner/renommer des pages pour éviter la duplication.
`

// ──────────────────────────────────────────────────────────── Settings helpers

function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
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

function getConfiguredFolder(): string | null {
  return readSetting(SETTINGS_FOLDER_KEY)
}

// ──────────────────────────────────────────────────────────── Path validation

// Empêche toute évasion hors du dossier wiki (path traversal). On assemble
// avec `path.join` puis on vérifie que le chemin résolu commence bien par le
// dossier configuré — sinon on jette, car c'est soit un bug, soit une
// tentative d'injection (nom avec `..` ou séparateurs exotiques).
function resolveSafePath(folder: string, subdir: string, filename: string): string {
  const target = path.resolve(folder, subdir, filename)
  const base = path.resolve(folder, subdir)
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error(`Chemin wiki invalide (hors dossier) : ${filename}`)
  }
  return target
}

// ──────────────────────────────────────────────────────────── Status

export async function getWikiStatus(): Promise<WikiFolderStatusT> {
  const folderPath = getConfiguredFolder()
  if (!folderPath) {
    return { folderPath: null, initialized: false, rawCount: 0, wikiCount: 0 }
  }
  // On re-teste à chaque appel car l'utilisateur peut avoir supprimé le
  // dossier manuellement entre deux sessions. `initialized: true` ne
  // garantit pas la présence physique.
  const rawPath = path.join(folderPath, RAW_DIR)
  const wikiPath = path.join(folderPath, WIKI_DIR)
  const memoryPath = path.join(folderPath, MEMORY_FILENAME)

  const [rawDirExists, wikiDirExists, memoryExists] = await Promise.all([
    exists(rawPath),
    exists(wikiPath),
    exists(memoryPath)
  ])
  const physicallyInitialized = rawDirExists && wikiDirExists && memoryExists

  if (!physicallyInitialized) {
    return { folderPath, initialized: false, rawCount: 0, wikiCount: 0 }
  }

  const [rawEntries, wikiEntries] = await Promise.all([
    listMarkdownFiles(rawPath),
    listMarkdownFiles(wikiPath)
  ])
  return {
    folderPath,
    initialized: true,
    rawCount: rawEntries.length,
    wikiCount: wikiEntries.length
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// ──────────────────────────────────────────────────────────── Choix & init

// Enregistre un nouveau dossier et crée la structure si absente. Idempotent :
// si le dossier est déjà initialisé, on ne touche à rien — évite d'écraser
// un MEMORY.md édité par l'utilisateur ou un wiki existant.
export async function setWikiFolder(folderPath: string): Promise<WikiFolderStatusT> {
  const resolved = path.resolve(folderPath)
  await fs.mkdir(resolved, { recursive: true })
  writeSetting(SETTINGS_FOLDER_KEY, resolved)

  await initStructureIfNeeded(resolved)
  writeSetting(SETTINGS_INITIALIZED_KEY, '1')

  return getWikiStatus()
}

async function initStructureIfNeeded(folder: string): Promise<void> {
  const rawPath = path.join(folder, RAW_DIR)
  const wikiPath = path.join(folder, WIKI_DIR)
  const memoryPath = path.join(folder, MEMORY_FILENAME)

  await Promise.all([
    fs.mkdir(rawPath, { recursive: true }),
    fs.mkdir(wikiPath, { recursive: true })
  ])

  if (!(await exists(memoryPath))) {
    await fs.writeFile(memoryPath, MEMORY_TEMPLATE, 'utf8')
  }
}

// ──────────────────────────────────────────────────────────── Listing / Read / Write

async function listMarkdownFiles(dir: string): Promise<WikiEntryT[]> {
  try {
    const names = await fs.readdir(dir)
    const mdNames = names.filter((n) => n.endsWith('.md'))
    const entries = await Promise.all(
      mdNames.map(async (name) => {
        const stat = await fs.stat(path.join(dir, name))
        return { name, size: stat.size, modifiedAt: stat.mtimeMs }
      })
    )
    entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return entries
  } catch {
    return []
  }
}

function ensureConfigured(): string {
  const folder = getConfiguredFolder()
  if (!folder) {
    throw new Error(
      'Dossier wiki non configuré. Ouvrez Paramètres > Wiki pour choisir un dossier.'
    )
  }
  return folder
}

export async function listRaw(): Promise<WikiEntryT[]> {
  const folder = getConfiguredFolder()
  if (!folder) return []
  return listMarkdownFiles(path.join(folder, RAW_DIR))
}

export async function listWiki(): Promise<WikiEntryT[]> {
  const folder = getConfiguredFolder()
  if (!folder) return []
  return listMarkdownFiles(path.join(folder, WIKI_DIR))
}

export async function readRaw(name: string): Promise<string> {
  const folder = ensureConfigured()
  const p = resolveSafePath(folder, RAW_DIR, name)
  return fs.readFile(p, 'utf8')
}

export async function readWiki(name: string): Promise<string> {
  const folder = ensureConfigured()
  const p = resolveSafePath(folder, WIKI_DIR, name)
  return fs.readFile(p, 'utf8')
}

export async function readMemoryTemplate(): Promise<string | null> {
  const folder = getConfiguredFolder()
  if (!folder) return null
  try {
    return await fs.readFile(path.join(folder, MEMORY_FILENAME), 'utf8')
  } catch {
    return null
  }
}

export async function writeRaw(name: string, content: string): Promise<void> {
  const folder = ensureConfigured()
  await initStructureIfNeeded(folder)
  const p = resolveSafePath(folder, RAW_DIR, name)
  await fs.writeFile(p, content, 'utf8')
}

export async function writeWiki(name: string, content: string): Promise<void> {
  const folder = ensureConfigured()
  await initStructureIfNeeded(folder)
  const p = resolveSafePath(folder, WIKI_DIR, name)
  await fs.writeFile(p, content, 'utf8')
}

// Ouvre le dossier wiki dans l'explorateur OS. Renvoie une chaîne vide en
// succès (comportement de `shell.openPath`) ou un message d'erreur.
export async function openFolderInExplorer(): Promise<string> {
  const folder = ensureConfigured()
  return shell.openPath(folder)
}
