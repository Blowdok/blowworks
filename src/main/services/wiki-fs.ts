import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { shell } from 'electron'
import { getDb } from './db.js'
import type { WikiFolderStatusT, WikiEntryT } from '@shared/ipc-contract.js'

// Service FS pour la « mémoire long-terme » de BlowWorks.
//
// Architecture inspirée de Karpathy LLM Wiki + claude-memory-compiler —
// analogie du compilateur (voir SCHEMA.md généré à l'init) :
//
//   raw/        = code source    (conversations brutes, immutable, append-only)
//   compiled/*  = exécutable     (pages wiki structurées, owned by LLM)
//   SCHEMA.md   = spec compiler  (conventions, workflows, règles YAML)
//   index.md    = table maître   (catalogue plat, retrieval canonique)
//   log.md      = journal        (append-only chronologique parsable)
//
// Les noms de dossiers sur disque restent `raw/` et `wiki/` pour conserver
// la rétrocompat avec les installs existantes ; dans le SCHEMA on parle
// de "source" et "compiled" (terminologie Karpathy/compiler-analogy).
//
// Settings SQLite :
//   - `wiki.folderPath`  : chemin absolu ou absent
//   - `wiki.initialized` : '1' une fois la structure créée
//
// Onboarding paresseux : rien n'est fait au boot. L'utilisateur ouvre
// Settings > Wiki pour choisir un dossier. Les handlers list/read/write
// vérifient d'abord que le dossier est configuré — sinon ils retournent
// un état neutre (listes vides, null) pour que les appelants (agents)
// puissent no-op silencieusement.

const SETTINGS_FOLDER_KEY = 'wiki.folderPath'
const SETTINGS_INITIALIZED_KEY = 'wiki.initialized'
const RAW_DIR = 'raw'
const WIKI_DIR = 'wiki'
const SCHEMA_FILENAME = 'SCHEMA.md'
const LEGACY_SCHEMA_FILENAME = 'MEMORY.md' // migration auto au 1er boot v2
const INDEX_FILENAME = 'index.md' // vit DANS wiki/
const LOG_FILENAME = 'log.md' // vit à la racine du wikiFolder
// Fichier d'état de la compilation incrémentale (pattern claude-memory-
// compiler `state.json`). Mappe `<raw-name> → { hash, compiledAt }` pour
// que le Wiki Builder saute les raw dont le contenu n'a pas changé
// depuis la dernière compilation. Prefix `.` = masqué par convention
// Unix, mais reste visible dans l'explorateur Windows — acceptable.
const COMPILE_STATE_FILENAME = '.compile-state.json'

// Template bootstrap du SCHEMA.md — généré à l'init si absent. Édité par
// l'utilisateur ensuite (jamais écrasé par la suite). Injecté IN EXTENSO
// dans le prompt du Wiki Builder pour garantir la cohérence des articles.
const SCHEMA_TEMPLATE = `# SCHEMA.md — Mémoire long-terme BlowWorks

## Analogie du compilateur

\`\`\`
raw/          = code source      (tes conversations — la matière brute)
LLM           = compilateur      (extrait et organise la connaissance)
wiki/         = exécutable       (pages structurées, interconnectées)
lint          = tests            (vérifie la cohérence)
wiki/index.md = table maître     (unique mécanisme de retrieval)
log.md        = journal          (append-only chronologique)
\`\`\`

Tu n'organises jamais ta mémoire à la main. Tu discutes, tu actionnes. Les agents synthétisent, compilent, cross-référencent, lintent.

## Structure

- \`raw/\` : synthèses brutes horodatées produites par l'agent Synthétiseur depuis les chats. **IMMUTABLE** — jamais édité, jamais supprimé (append-only).
- \`wiki/\` : pages structurées produites par le Wiki Builder.
  - Arborescence libre : \`concepts/\`, \`connections/\`, \`qa/\` sont des conventions, pas des obligations.
  - Chaque page porte un frontmatter YAML typé (voir ci-dessous).
- \`wiki/index.md\` : catalogue plat de toutes les pages, maintenu par le Wiki Builder.
- \`log.md\` (à la racine du dossier) : journal append-only chronologique avec préfixe parsable \`## [ISO8601] type | résumé\`.
- \`audit/\` : rapports Lint horodatés (créé à la volée).
- \`fact-check-log.md\` : auto-corrections, faits marqués \`to-verify\` (créé à la volée).

## Conventions de nommage

- Fichiers : **kebab-case**, accents supprimés (ex : "Décision tech" → \`decision-tech.md\`).
- Liens inter-pages : \`[[nom-page]]\` (sans extension, sans chemin — résolution tolérante).
- Dates : **ISO 8601** strict (\`YYYY-MM-DD\` ou \`YYYY-MM-DDTHH:MM\`).

## Frontmatter YAML obligatoire (chaque page wiki/)

\`\`\`yaml
---
titre: "Nom canonique"
type: concept | connection | qa | projet | personne | outil | décision
statut: verified | to-verify | stub | archived
importance: pilier | standard | deep-cut
tags: [#projet/xxx, #outil/yyy]
liens_forts: ["[[autre-page]]"]
sources: ["raw/2026-04-23.md"]
source_knowledge: internal | web-checked | mixed
créé: 2026-04-23
modifié: 2026-04-23
---
\`\`\`

## Structure d'une page wiki/

\`\`\`markdown
# Titre

> [!info] Résumé
> 1-2 phrases de pitch.

## Contexte
2-3 paragraphes.

## Détails
Le cœur de l'article.

## Points clés
- Bullet 1
- Bullet 2

## Concepts liés
- [[xxx]] — pourquoi le lien
- [[yyy]] — pourquoi le lien

## Sources
- \`raw/2026-04-23.md\` — ce qui a été extrait
\`\`\`

Contraintes : **200-1500 mots**, minimum **3 wikilinks sortants** quand la KB contient >5 pages.

## Workflow Ingest (Synthétiseur)

1. **Trigger** : bouton ✦ dans l'en-tête d'une ChatShape.
2. **Input** : transcript complet de la conversation.
3. **Output** : un fichier \`raw/conv-<id>-<timestamp>.md\` au format structuré (sections fixes).
4. **Règle** : si rien ne vaut d'être sauvé, l'agent répond exactement \`FLUSH_OK\` et rien n'est écrit.

## Workflow Compile (Wiki Builder)

1. **Trigger** : bouton ✦ dans la section Mémoire OU Settings > Wiki > Reconstruire.
2. **Input** : ce fichier + \`wiki/index.md\` + tous les articles \`wiki/*.md\` existants + les fichiers \`raw/*.md\` à traiter.
3. **Output** : JSON \`{ operations: [{op, filename, content}], indexUpdate, logEntry }\`.
4. **Règle** : préfère UPDATE à CREATE pour éviter les doublons. Contradictions → \`statut: to-verify\` + section \`## Notes\` avec les deux versions.

## Workflow Lint (santé) — à venir Sprint 2

1. **Trigger** : bouton "Health check" dans la section Mémoire.
2. **Checks** : 6 déterministes (broken-ref, orphans, ghost-concepts, stale, sparse, orphan-sources) + 1 LLM (contradictions).
3. **Output** : rapport \`audit/YYYY-MM-DD.md\` + format machine-parseable \`CONTRADICTION: a vs b - description\` ou \`NO_ISSUES\`.

## Règles anti-hallucination

1. Aucun nom propre inventé. Si l'info vient de l'IA et non de la conversation, préfixer \`(inféré)\`.
2. Aucune date / chiffre / citation fabriqués. À défaut : "date à confirmer".
3. Distinguer faits REPORTÉS par l'utilisateur (certains) des hypothèses de l'IA → \`statut: to-verify\`.
4. Auto-corriger dans \`fact-check-log.md\` quand une hallucination est détectée.
`

const INDEX_TEMPLATE = `# Index — Wiki BlowWorks

Catalogue plat de toutes les pages \`wiki/\`. Maintenu automatiquement par l'agent Wiki Builder.

| Titre | Type | Importance | Résumé |
|-------|------|------------|--------|
| _(vide pour le moment)_ | | | |
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
  const schemaPath = path.join(folderPath, SCHEMA_FILENAME)
  const legacySchemaPath = path.join(folderPath, LEGACY_SCHEMA_FILENAME)

  const [rawDirExists, wikiDirExists, schemaExists, legacyExists] = await Promise.all([
    exists(rawPath),
    exists(wikiPath),
    exists(schemaPath),
    exists(legacySchemaPath)
  ])
  // On accepte SCHEMA.md OU l'ancien MEMORY.md (une install antérieure à
  // v2). La migration proprement dite est faite dans initStructureIfNeeded.
  const physicallyInitialized = rawDirExists && wikiDirExists && (schemaExists || legacyExists)

  if (!physicallyInitialized) {
    return { folderPath, initialized: false, rawCount: 0, wikiCount: 0 }
  }

  const [rawEntries, wikiEntries] = await Promise.all([
    listMarkdownFiles(rawPath),
    listMarkdownFiles(wikiPath)
  ])
  // On ne compte PAS `index.md` dans wikiCount — c'est un fichier de
  // maintenance, pas un article de connaissance.
  const wikiCount = wikiEntries.filter((e) => e.name !== INDEX_FILENAME).length
  return {
    folderPath,
    initialized: true,
    rawCount: rawEntries.length,
    wikiCount
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
  const schemaPath = path.join(folder, SCHEMA_FILENAME)
  const legacyPath = path.join(folder, LEGACY_SCHEMA_FILENAME)
  const indexPath = path.join(wikiPath, INDEX_FILENAME)
  const logPath = path.join(folder, LOG_FILENAME)

  await Promise.all([
    fs.mkdir(rawPath, { recursive: true }),
    fs.mkdir(wikiPath, { recursive: true })
  ])

  // Migration MEMORY.md → SCHEMA.md : si l'ancien nom existe sans le
  // nouveau, on rename (préserve les customisations de l'utilisateur).
  // Si les deux existent, on laisse l'utilisateur gérer le doublon —
  // pas d'écrasement silencieux de sa version.
  const [schemaExists, legacyExists] = await Promise.all([
    exists(schemaPath),
    exists(legacyPath)
  ])
  if (!schemaExists && legacyExists) {
    await fs.rename(legacyPath, schemaPath)
  } else if (!schemaExists && !legacyExists) {
    await fs.writeFile(schemaPath, SCHEMA_TEMPLATE, 'utf8')
  }

  // Index et log : créés vides au 1er boot v2. Ne pas écraser si déjà là.
  if (!(await exists(indexPath))) {
    await fs.writeFile(indexPath, INDEX_TEMPLATE, 'utf8')
  }
  if (!(await exists(logPath))) {
    const now = new Date().toISOString()
    await fs.writeFile(logPath, `# Journal — Wiki BlowWorks\n\n## [${now}] init | dossier wiki initialisé\n`, 'utf8')
  }
}

// ──────────────────────────────────────────────────────────── Listing / Read / Write

// Scan récursif des .md dans `dir` et tous ses sous-dossiers. Les `name`
// retournés sont RELATIFS au dossier racine et utilisent TOUJOURS le
// séparateur `/` (pattern URL / markdown) — `readWiki`/`writeWiki` et
// les wikilinks les utilisent sans conversion.
//
// Sans cette récursion, les pages dans wiki/concepts/, wiki/connections/
// ou wiki/qa/ étaient invisibles (fs.readdir non-récursif) → l'index
// affichait 0 pages alors que le Wiki Builder en avait créé.
async function listMarkdownFiles(dir: string): Promise<WikiEntryT[]> {
  const out: WikiEntryT[] = []
  async function walk(abs: string, rel: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(abs)
    } catch {
      return
    }
    for (const name of names) {
      const absChild = path.join(abs, name)
      const relChild = rel ? `${rel}/${name}` : name
      let stat
      try {
        // `lstat` au lieu de `stat` : n'suit PAS les symlinks. Essentiel
        // pour éviter une boucle infinie si l'utilisateur a un lien
        // circulaire dans son dossier wiki (ex: `wiki/foo -> ../wiki/`).
        // Les symlinks eux-mêmes sont skippés — on ne walk que les vrais
        // dossiers et on ne liste que les vrais fichiers .md.
        stat = await fs.lstat(absChild)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) {
        // Skip silencieux : on ne traverse pas les liens pour rester
        // prévisible et éviter les surprises (lien vers fichier externe
        // = même risque de hang + accès hors sandbox).
        continue
      }
      if (stat.isDirectory()) {
        await walk(absChild, relChild)
      } else if (stat.isFile() && name.endsWith('.md')) {
        out.push({ name: relChild, size: stat.size, modifiedAt: stat.mtimeMs })
      }
    }
  }
  await walk(dir, '')
  out.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return out
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

// Liste les PAGES wiki (articles de connaissance). Exclut `index.md`
// qui est un fichier de maintenance, pas un article — sinon il remonte
// dans les dropdowns et les injections 📚 comme s'il était du contenu.
export async function listWiki(): Promise<WikiEntryT[]> {
  const folder = getConfiguredFolder()
  if (!folder) return []
  const all = await listMarkdownFiles(path.join(folder, WIKI_DIR))
  return all.filter((e) => e.name !== INDEX_FILENAME)
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

// Lecture du SCHEMA.md — source de vérité des conventions. Fallback
// transparent sur l'ancien nom MEMORY.md si on n'a pas encore migré
// (évite qu'une app fraîche appelée avant initStructureIfNeeded retourne
// null alors qu'un ancien fichier existe encore).
export async function readSchema(): Promise<string | null> {
  const folder = getConfiguredFolder()
  if (!folder) return null
  try {
    return await fs.readFile(path.join(folder, SCHEMA_FILENAME), 'utf8')
  } catch {
    // Fallback MEMORY.md pour les installations antérieures à v2
    // n'ayant pas encore déclenché setWikiFolder post-upgrade.
    try {
      return await fs.readFile(path.join(folder, LEGACY_SCHEMA_FILENAME), 'utf8')
    } catch {
      return null
    }
  }
}

// Alias deprecated — garde l'API preload stable le temps que le renderer
// migre. TODO sprint 2 : retirer après grep global.
export const readMemoryTemplate = readSchema

// Lecture de wiki/index.md (catalogue maître consommé par le chat et par
// le Wiki Builder). Retourne null si absent plutôt que throw pour que
// l'injection 📚 puisse no-op proprement.
export async function readIndex(): Promise<string | null> {
  const folder = getConfiguredFolder()
  if (!folder) return null
  try {
    return await fs.readFile(path.join(folder, WIKI_DIR, INDEX_FILENAME), 'utf8')
  } catch {
    return null
  }
}

// Écriture de wiki/index.md par le Wiki Builder. Valide la taille max
// pour éviter un bug d'agent qui produirait un index démesuré.
export async function writeIndex(content: string): Promise<void> {
  const folder = ensureConfigured()
  if (content.length > 1_000_000) {
    throw new Error(`index.md trop volumineux (${content.length} caractères, max 1 Mo)`)
  }
  await initStructureIfNeeded(folder)
  await fs.writeFile(path.join(folder, WIKI_DIR, INDEX_FILENAME), content, 'utf8')
}

// Append à log.md. Préfixe format parsable : `## [ISO8601] type | résumé`.
// Tout ce qui est passé en `entry` est ajouté tel quel — il incombe à
// l'appelant de formater avec ce préfixe (cf. agents-manager).
export async function appendLog(entry: string): Promise<void> {
  const folder = ensureConfigured()
  await initStructureIfNeeded(folder)
  const logPath = path.join(folder, LOG_FILENAME)
  const trimmed = entry.endsWith('\n') ? entry : entry + '\n'
  await fs.appendFile(logPath, trimmed, 'utf8')
}

// Lecture du log complet — utile pour la UI (onglet journal futur).
export async function readLog(): Promise<string | null> {
  const folder = getConfiguredFolder()
  if (!folder) return null
  try {
    return await fs.readFile(path.join(folder, LOG_FILENAME), 'utf8')
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
  // mkdir récursif au cas où `name` pointe vers un sous-dossier
  // (ex: "concepts/pagemark.md") qui n'existe pas encore.
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content, 'utf8')
}

// Rename utilisé par le Wiki Builder pour fusionner/déplacer des pages
// sans perte de contenu. Refuse si destination existe déjà — évite les
// écrasements silencieux lors d'un rename en masse.
export async function renameWiki(from: string, to: string): Promise<void> {
  const folder = ensureConfigured()
  const src = resolveSafePath(folder, WIKI_DIR, from)
  const dst = resolveSafePath(folder, WIKI_DIR, to)
  if (await exists(dst)) {
    throw new Error(`Rename refusé : la destination existe déjà (${to})`)
  }
  await fs.mkdir(path.dirname(dst), { recursive: true })
  await fs.rename(src, dst)
}

// Delete d'une page wiki. Réservé au Wiki Builder pour la fusion
// post-rename. Le raw/ n'est jamais supprimé (append-only).
export async function deleteWiki(name: string): Promise<void> {
  const folder = ensureConfigured()
  const p = resolveSafePath(folder, WIKI_DIR, name)
  await fs.unlink(p)
}

// Ouvre le dossier wiki dans l'explorateur OS. Renvoie une chaîne vide en
// succès (comportement de `shell.openPath`) ou un message d'erreur.
export async function openFolderInExplorer(): Promise<string> {
  const folder = ensureConfigured()
  return shell.openPath(folder)
}

// ──────────────────────────────────────────────────────────── Compile state (Sprint 4)

export interface CompileStateEntry {
  hash: string
  compiledAt: number
}

export interface CompileState {
  version: number
  ingested: Record<string, CompileStateEntry>
}

const EMPTY_COMPILE_STATE: CompileState = { version: 1, ingested: {} }

// Hash SHA-256 d'un fichier raw — normalisé sur son contenu UTF-8.
// Utilisé pour détecter si un raw a changé depuis sa dernière
// compilation : même contenu → même hash → skip l'envoi au LLM.
export function computeRawHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Lit l'état de compilation du wiki depuis `.compile-state.json`.
// Retourne un état vide si le fichier est absent ou corrompu (la
// prochaine compilation recréera l'état complet — no harm).
export async function readCompileState(): Promise<CompileState> {
  const folder = getConfiguredFolder()
  if (!folder) return { ...EMPTY_COMPILE_STATE }
  try {
    const text = await fs.readFile(path.join(folder, COMPILE_STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(text) as Partial<CompileState>
    if (parsed && typeof parsed === 'object' && parsed.ingested && typeof parsed.ingested === 'object') {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        ingested: parsed.ingested as Record<string, CompileStateEntry>
      }
    }
  } catch {
    // Fichier absent ou corrompu : on repart d'un état vide.
  }
  return { ...EMPTY_COMPILE_STATE }
}

// Écrit l'état de compilation. Le Wiki Builder appelle ça après chaque
// batch réussi pour marquer les raw comme "déjà compilés". Atomique
// via writeFile (better-sqlite3 equivalent : le FS NTFS/ext4 garantit
// que writeFile est atomique jusqu'à la taille d'un bloc de secteur,
// >64 KB est découpé mais une corruption partielle sera détectée par
// `readCompileState` qui tombe sur un JSON invalide → état vide).
export async function writeCompileState(state: CompileState): Promise<void> {
  const folder = ensureConfigured()
  const text = JSON.stringify(state, null, 2)
  await fs.writeFile(path.join(folder, COMPILE_STATE_FILENAME), text, 'utf8')
}

// Ouvre directement le sous-dossier `raw/` dans l'explorateur — utile
// pour le glisser-déposer manuel de notes (l'utilisateur peut y poser
// des .md à la main, le Wiki Builder les compilera au prochain run).
export async function openRawInExplorer(): Promise<string> {
  const folder = ensureConfigured()
  await initStructureIfNeeded(folder)
  return shell.openPath(path.join(folder, RAW_DIR))
}

// ──────────────────────────────────────────────────────────── Import manuel

// Importe un fichier externe dans `raw/` après normalisation du nom et
// validation de l'extension. Le contenu est COPIÉ tel quel — c'est au
// Wiki Builder de l'interpréter à la compilation suivante. La conversion
// de format avancée (.pdf → .md, .html → .md) viendra plus tard via
// `turndown` / `pdf-parse` si l'utilisateur le demande.
//
// Formats acceptés. Texte brut = copie directe. HTML = conversion via
// turndown. PDF = extraction de texte via pdf-parse. Toute autre
// extension est rejetée — le Wiki Builder lit du markdown, pas des
// binaires arbitraires.
const ALLOWED_IMPORT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.html',
  '.htm',
  '.pdf'
])
const TEXT_IMPORT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const HTML_IMPORT_EXTENSIONS = new Set(['.html', '.htm'])
const PDF_IMPORT_EXTENSIONS = new Set(['.pdf'])
// Limite globale 10 MiB pour supporter des PDFs un peu épais.
// Texte/HTML reste limité à 5 MiB pour éviter les bombes zip style
// HTML qui explosent en markdown.
const MAX_IMPORT_BYTES_TEXT = 5_000_000
const MAX_IMPORT_BYTES_PDF = 10_000_000

export interface ImportResult {
  sourcePath: string
  targetName: string | null
  bytes: number
  error: string | null
}

export async function importToRaw(sourcePaths: string[]): Promise<ImportResult[]> {
  const folder = ensureConfigured()
  await initStructureIfNeeded(folder)
  const rawPath = path.join(folder, RAW_DIR)
  const results: ImportResult[] = []

  for (const sourcePath of sourcePaths) {
    try {
      const ext = path.extname(sourcePath).toLowerCase()
      if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) {
        results.push({
          sourcePath,
          targetName: null,
          bytes: 0,
          error: `Extension non supportée : ${ext || '(aucune)'}. Accepté : .md, .markdown, .txt, .html, .htm, .pdf.`
        })
        continue
      }
      const stat = await fs.stat(sourcePath)
      const maxBytes = PDF_IMPORT_EXTENSIONS.has(ext)
        ? MAX_IMPORT_BYTES_PDF
        : MAX_IMPORT_BYTES_TEXT
      if (stat.size > maxBytes) {
        results.push({
          sourcePath,
          targetName: null,
          bytes: stat.size,
          error: `Fichier trop volumineux (${formatSize(stat.size)}, max ${formatSize(maxBytes)}).`
        })
        continue
      }

      // Lecture + conversion selon le type. Texte = tel quel, HTML =
      // turndown, PDF = pdf-parse. Les conversions peuvent throw — on
      // catch par fichier pour ne pas bloquer les imports valides du
      // même batch.
      let content: string
      if (TEXT_IMPORT_EXTENSIONS.has(ext)) {
        content = await fs.readFile(sourcePath, 'utf8')
      } else if (HTML_IMPORT_EXTENSIONS.has(ext)) {
        const html = await fs.readFile(sourcePath, 'utf8')
        content = await convertHtmlToMarkdown(html, sourcePath)
      } else if (PDF_IMPORT_EXTENSIONS.has(ext)) {
        const buf = await fs.readFile(sourcePath)
        content = await convertPdfToMarkdown(buf, sourcePath)
      } else {
        // Safety net : ALLOWED_IMPORT_EXTENSIONS couvre déjà tout au-dessus.
        throw new Error(`Extension traitée non reconnue : ${ext}`)
      }

      const targetName = await uniqueRawName(rawPath, sourcePath)
      const targetPath = resolveSafePath(folder, RAW_DIR, targetName)
      await fs.writeFile(targetPath, content, 'utf8')
      results.push({
        sourcePath,
        targetName,
        bytes: content.length,
        error: null
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({
        sourcePath,
        targetName: null,
        bytes: 0,
        error: msg
      })
    }
  }

  // Append au log un résumé d'opération pour audit.
  const ok = results.filter((r) => r.error === null).length
  if (ok > 0) {
    const iso = new Date().toISOString()
    await fs.appendFile(
      path.join(folder, LOG_FILENAME),
      `## [${iso}] import | ${ok} fichier${ok > 1 ? 's' : ''} ajouté${ok > 1 ? 's' : ''} dans raw/\n`,
      'utf8'
    )
  }

  return results
}

// Génère un nom de fichier raw unique à partir du nom source.
// Forme : `import-<slug>-<timestamp>.md`. `.md` forcé pour cohérence
// avec le reste de raw/ même si la source était un .txt.
async function uniqueRawName(rawPath: string, sourcePath: string): Promise<string> {
  const base = path
    .basename(sourcePath, path.extname(sourcePath))
    .toLowerCase()
    // Normalise unicode → ASCII, supprime les accents.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Tout caractère non word/dash → tiret.
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

  const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let candidate = `import-${base || 'note'}-${iso}.md`
  // Garde-fou : si collision (très improbable avec timestamp à la seconde),
  // suffixe -1, -2, …
  let suffix = 1
  while (await pathExists(path.join(rawPath, candidate))) {
    candidate = `import-${base || 'note'}-${iso}-${suffix}.md`
    suffix++
    if (suffix > 99) throw new Error('Trop de collisions de nom — abandon.')
  }
  return candidate
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ──────────────────────────────────────────────────────────── Conversions

// HTML → markdown via turndown + turndown-plugin-gfm pour les tables.
// On préfixe le résultat d'un mini-frontmatter source pour que le Wiki
// Builder sache que ce raw vient d'un import HTML externe (utile pour
// la traçabilité dans `sources:`).
async function convertHtmlToMarkdown(html: string, sourcePath: string): Promise<string> {
  // Import dynamique : turndown est une dépendance côté main, pas
  // besoin qu'elle vive dans le graph de dépendances du renderer.
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_'
  })
  // Ignore les blocs qui n'apportent rien à une note (nav, scripts,
  // styles, footers HTML auto-générés type "Copyright").
  td.remove(['script', 'style', 'noscript', 'iframe'])
  const markdown = td.turndown(html)

  // Essaie de récupérer un titre depuis <title> ou <h1> pour le mettre
  // en H1 au début du markdown si absent.
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const guessedTitle = (titleMatch?.[1] || h1Match?.[1] || '').replace(/<[^>]+>/g, '').trim()

  const header = buildImportHeader(sourcePath, guessedTitle, 'html')
  return `${header}\n\n${markdown.trim()}\n`
}

// PDF → markdown via pdf-parse. Le texte extrait est déjà plat (pas
// de structure de doc préservée), on ajoute juste un titre H1 depuis
// les métadonnées si disponibles + le frontmatter d'import.
async function convertPdfToMarkdown(buffer: Buffer, sourcePath: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  // pdf-parse attend Uint8Array. `Buffer` est une sous-classe mais le
  // passer directement peut throw selon la version — on convertit
  // explicitement.
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const textResult = await parser.getText()
    let guessedTitle = ''
    try {
      const info = await parser.getInfo()
      // InfoResult expose typiquement info.info.Title / Author / etc.
      const infoObj = (info as { info?: Record<string, unknown> }).info
      const rawTitle = infoObj && typeof infoObj.Title === 'string' ? infoObj.Title : ''
      guessedTitle = rawTitle.trim()
    } catch {
      // Pas bloquant : si la métadonnée échoue, on continue sans titre.
    }

    const header = buildImportHeader(sourcePath, guessedTitle, 'pdf')
    // Le texte PDF brut contient souvent des retours à la ligne aberrants
    // (chaque ligne physique du PDF devient une newline). On normalise :
    // - Join les lignes courtes adjacentes en paragraphes
    // - Respecte les sauts de paragraphe réels (lignes vides)
    const cleaned = normalizePdfText(textResult.text)
    return `${header}\n\n${cleaned}\n`
  } finally {
    await parser.destroy().catch(() => {
      /* best-effort cleanup */
    })
  }
}

// Normalise le texte brut d'un PDF : rejoint les lignes courtes en
// paragraphes lisibles. Heuristique simple (pas parfait, mais suffisant
// pour un raw destiné au LLM) :
//   - Ligne vide = séparateur de paragraphe (préservé)
//   - Ligne se terminant par `.`, `!`, `?`, `:` = fin de paragraphe
//   - Sinon on join avec un espace (reflow)
function normalizePdfText(text: string): string {
  const lines = text.split(/\r?\n/)
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '))
        current = []
      }
    } else {
      current.push(trimmed)
      if (/[.!?:]$/.test(trimmed)) {
        paragraphs.push(current.join(' '))
        current = []
      }
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs.join('\n\n')
}

// Mini-frontmatter ajouté en tête des raw importés depuis PDF/HTML.
// Donne au Wiki Builder le contexte d'origine pour citer le `source:`
// et adapter le traitement (ex: un import PDF d'un papier scientifique
// mérite un article concept, pas une page qa/).
function buildImportHeader(sourcePath: string, guessedTitle: string, kind: string): string {
  const basename = path.basename(sourcePath)
  const title = guessedTitle || basename.replace(/\.(pdf|html?|htm)$/i, '')
  const iso = new Date().toISOString()
  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source_kind: ${kind}`,
    `source_file: "${basename.replace(/"/g, '\\"')}"`,
    `imported_at: ${iso}`,
    '---',
    '',
    `# ${title}`
  ].join('\n')
}
