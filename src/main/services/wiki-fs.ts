import { promises as fs } from 'node:fs'
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
