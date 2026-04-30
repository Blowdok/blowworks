// Boutons custom du Header (à droite de Terminal/VSCode/Chat) — entièrement
// configurables depuis Settings > Navigateur. Chaque bouton ouvre un arbre
// d'entrées qui peuvent être :
//   • Items terminaux : { label, url, tagline? } — clic = spawn BrowserShape
//   • Dossiers : { label, children: Entry[] } — purement organisationnel
//     (pas d'URL), permet de regrouper des sites par catégorie sur autant
//     de niveaux que voulu.
//
// Affichage :
//   • 0 entrée    → bouton désactivé (à configurer dans Réglages).
//   • 1 entrée    → clic = spawn direct si item, ou ouvre le sous-menu si dossier.
//   • 2+ entrées  → menu déroulant cascading. Les dossiers s'expandent en
//                   sous-menu à droite au survol/clic.
//
// Persistance : SQLite settings, clé `header.buttons`, valeur = JSON
// stringifié de `HeaderButton[]`. Hydratation au boot via le store
// `header-buttons-store`. Au premier lancement (clé absente / JSON
// invalide), on retombe sur `DEFAULT_HEADER_BUTTONS` qui reproduit le
// menu IA historique (10 services hardcodés ChatGPT, Claude, etc.).

import { z } from 'zod'

export interface HeaderButtonItem {
  readonly kind: 'item'
  readonly id: string
  readonly label: string
  readonly url: string
  // Sous-titre court affiché dans le menu déroulant (1 ligne). Optionnel.
  readonly tagline?: string
}

export interface HeaderButtonFolder {
  readonly kind: 'folder'
  readonly id: string
  readonly label: string
  readonly children: readonly HeaderButtonEntry[]
}

export type HeaderButtonEntry = HeaderButtonItem | HeaderButtonFolder

export interface HeaderButton {
  readonly id: string
  readonly label: string
  // Couleur de la pastille avec l'initiale (en racine de bouton + dans le
  // menu déroulant). Hex `#rrggbb` recommandé. Pas de validation stricte
  // pour rester souple — l'UI propose un color picker.
  readonly color: string
  readonly entries: readonly HeaderButtonEntry[]
}

// Schéma Zod récursif via `z.lazy` — `HeaderButtonEntry` est une union
// { kind: 'item' } | { kind: 'folder' } où les folders référencent
// récursivement le même schéma. Profondeur illimitée. On utilise
// `z.union` plutôt que `discriminatedUnion` car ce dernier ne supporte
// pas bien les références récursives via `z.lazy` en Zod v4 (les types
// internes se font invalider — cf. erreur TS2322 au build).
const HeaderButtonItemSchema = z.object({
  kind: z.literal('item'),
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().min(1),
  tagline: z.string().optional()
})

// Forward-declare le schéma entry pour rompre la dépendance cyclique
// folder → entry → folder. Le runtime `z.lazy` résout au premier accès,
// le typage explicite garantit que l'inférence `z.infer` retourne bien
// `HeaderButtonEntry` et pas `unknown`.
const HeaderButtonEntrySchema: z.ZodType<HeaderButtonEntry> = z.lazy(() =>
  z.union([HeaderButtonItemSchema, HeaderButtonFolderSchema])
)

const HeaderButtonFolderSchema: z.ZodType<HeaderButtonFolder> = z.lazy(() =>
  z.object({
    kind: z.literal('folder'),
    id: z.string().min(1),
    label: z.string().min(1),
    children: z.array(HeaderButtonEntrySchema)
  })
)

const HeaderButtonSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().min(1),
  entries: z.array(HeaderButtonEntrySchema)
})

const HeaderButtonsSchema = z.array(HeaderButtonSchema)

// Migration ascendante : l'ancien format v1 utilisait `items: { id, label,
// url, tagline? }[]` (liste plate, pas de hiérarchie). Si on lit du v1
// depuis SQLite (utilisateur déjà passé par la version précédente), on
// le convertit silencieusement en arbre v2 avant validation.
const HeaderButtonV1ItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().min(1),
  tagline: z.string().optional()
})

const HeaderButtonV1Schema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().min(1),
  items: z.array(HeaderButtonV1ItemSchema)
})

function migrateV1ToV2(v1: z.infer<typeof HeaderButtonV1Schema>): HeaderButton {
  return {
    id: v1.id,
    label: v1.label,
    color: v1.color,
    entries: v1.items.map((it) => ({
      kind: 'item' as const,
      id: it.id,
      label: it.label,
      url: it.url,
      tagline: it.tagline
    }))
  }
}

// Parse + valide la valeur SQLite (string JSON). Retourne `null` si vide,
// invalide ou JSON corrompu — l'appelant retombera sur le seed par défaut.
// Tolère le format v1 (liste plate `items`) et le migre en v2 (arbre
// `entries`) pour préserver la config des early adopters.
export function parseHeaderButtons(raw: string | null): HeaderButton[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    // Première tentative : format v2 (récursif).
    const v2 = HeaderButtonsSchema.safeParse(parsed)
    if (v2.success) return v2.data as HeaderButton[]
    // Fallback : format v1 (plat) — migration silencieuse.
    const v1 = z.array(HeaderButtonV1Schema).safeParse(parsed)
    if (v1.success) return v1.data.map(migrateV1ToV2)
    return null
  } catch {
    return null
  }
}

// Génère un id court non-cryptographique. Pas crypto.randomUUID() pour
// rester compat partout (le module est partagé renderer/main). Suffisant
// pour l'unicité dans un tableau de quelques boutons.
export function generateHeaderButtonId(): string {
  return `hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function generateHeaderEntryId(): string {
  return `hbe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── Helpers de manipulation d'arbre ───────────────────────────────────
// Toutes ces fonctions sont PURES et retournent une nouvelle structure
// (immutabilité garantie). Permet au store Zustand de détecter les
// changements via égalité référentielle pour ses réactivités.

// Trouve le chemin (liste d'ids de dossiers parents) qui mène à un
// entry donné. Retourne `[]` si l'entry est en racine, ou `null` s'il
// n'existe pas dans l'arbre.
export function findEntryPath(
  entries: readonly HeaderButtonEntry[],
  targetId: string
): string[] | null {
  for (const e of entries) {
    if (e.id === targetId) return []
    if (e.kind === 'folder') {
      const sub = findEntryPath(e.children, targetId)
      if (sub !== null) return [e.id, ...sub]
    }
  }
  return null
}

// Map immuable : applique une transformation à l'entry ciblé par son id.
// Si `transform` retourne `null`, l'entry est supprimé.
export function mapEntry(
  entries: readonly HeaderButtonEntry[],
  targetId: string,
  transform: (entry: HeaderButtonEntry) => HeaderButtonEntry | null
): HeaderButtonEntry[] {
  const out: HeaderButtonEntry[] = []
  for (const e of entries) {
    if (e.id === targetId) {
      const next = transform(e)
      if (next !== null) out.push(next)
      continue
    }
    if (e.kind === 'folder') {
      out.push({ ...e, children: mapEntry(e.children, targetId, transform) })
    } else {
      out.push(e)
    }
  }
  return out
}

// Insère un entry à la fin des enfants du dossier ciblé. Si `folderId`
// est `null`, insère en racine (au niveau du bouton).
export function insertEntry(
  entries: readonly HeaderButtonEntry[],
  folderId: string | null,
  newEntry: HeaderButtonEntry
): HeaderButtonEntry[] {
  if (folderId === null) {
    return [...entries, newEntry]
  }
  return entries.map((e) => {
    if (e.id === folderId && e.kind === 'folder') {
      return { ...e, children: [...e.children, newEntry] }
    }
    if (e.kind === 'folder') {
      return { ...e, children: insertEntry(e.children, folderId, newEntry) }
    }
    return e
  })
}

// Supprime un entry de l'arbre (par id, à n'importe quelle profondeur).
// Retourne le nouvel arbre + l'entry supprimé (utile pour `move`).
export function removeEntry(
  entries: readonly HeaderButtonEntry[],
  targetId: string
): { tree: HeaderButtonEntry[]; removed: HeaderButtonEntry | null } {
  let removed: HeaderButtonEntry | null = null
  const out: HeaderButtonEntry[] = []
  for (const e of entries) {
    if (e.id === targetId) {
      removed = e
      continue
    }
    if (e.kind === 'folder') {
      const sub = removeEntry(e.children, targetId)
      if (sub.removed) removed = sub.removed
      out.push({ ...e, children: sub.tree })
    } else {
      out.push(e)
    }
  }
  return { tree: out, removed }
}

// Réordonne deux frères au sein du même dossier (ou de la racine).
// `parentId = null` cible la racine du bouton.
export function reorderSibling(
  entries: readonly HeaderButtonEntry[],
  parentId: string | null,
  entryId: string,
  direction: -1 | 1
): HeaderButtonEntry[] {
  if (parentId === null) {
    return swap(entries, entryId, direction)
  }
  return entries.map((e) => {
    if (e.id === parentId && e.kind === 'folder') {
      return { ...e, children: swap(e.children, entryId, direction) }
    }
    if (e.kind === 'folder') {
      return { ...e, children: reorderSibling(e.children, parentId, entryId, direction) }
    }
    return e
  })
}

function swap(
  arr: readonly HeaderButtonEntry[],
  entryId: string,
  direction: -1 | 1
): HeaderButtonEntry[] {
  const idx = arr.findIndex((e) => e.id === entryId)
  if (idx === -1) return [...arr]
  const target = idx + direction
  if (target < 0 || target >= arr.length) return [...arr]
  const next = [...arr]
  ;[next[idx], next[target]] = [next[target], next[idx]]
  return next
}

// Récupère le parent direct d'un entry (id du folder parent ou `null` si
// en racine, `undefined` si l'entry n'existe pas du tout).
export function findParentId(
  entries: readonly HeaderButtonEntry[],
  targetId: string,
  currentParent: string | null = null
): string | null | undefined {
  for (const e of entries) {
    if (e.id === targetId) return currentParent
    if (e.kind === 'folder') {
      const sub = findParentId(e.children, targetId, e.id)
      if (sub !== undefined) return sub
    }
  }
  return undefined
}

// Liste tous les dossiers de l'arbre avec leur chemin complet (suite de
// labels). Utilisé par l'UI Settings pour le picker "Déplacer vers...".
// Format : `[{ id, path: 'Dossier > Sous-dossier > ...' }]`. La racine
// est représentée par `id = null`, `path = '(racine)'`.
export interface FolderListing {
  id: string | null
  path: string
  // Profondeur dans l'arbre (0 = racine du bouton, 1 = enfant direct
  // d'un folder racine, etc.). Sert à indenter l'UI du picker.
  depth: number
}

export function listFolders(
  entries: readonly HeaderButtonEntry[]
): FolderListing[] {
  const out: FolderListing[] = [{ id: null, path: '(racine)', depth: 0 }]
  function walk(es: readonly HeaderButtonEntry[], prefix: string, depth: number): void {
    for (const e of es) {
      if (e.kind === 'folder') {
        const path = prefix ? `${prefix} › ${e.label}` : e.label
        out.push({ id: e.id, path, depth })
        walk(e.children, path, depth + 1)
      }
    }
  }
  walk(entries, '', 1)
  return out
}

// Vérifie qu'un dossier candidat n'est pas dans la sous-arborescence de
// `sourceId` — déplacement interdit pour éviter les cycles. Retourne
// true si `candidateFolderId` est un descendant (direct ou indirect)
// de `sourceId`, ou si c'est `sourceId` lui-même.
export function isDescendantFolder(
  entries: readonly HeaderButtonEntry[],
  sourceId: string,
  candidateFolderId: string
): boolean {
  if (sourceId === candidateFolderId) return true
  function findFolder(
    es: readonly HeaderButtonEntry[],
    id: string
  ): HeaderButtonFolder | null {
    for (const e of es) {
      if (e.id === id && e.kind === 'folder') return e
      if (e.kind === 'folder') {
        const sub = findFolder(e.children, id)
        if (sub) return sub
      }
    }
    return null
  }
  const source = findFolder(entries, sourceId)
  if (!source) return false
  function contains(folder: HeaderButtonFolder, id: string): boolean {
    for (const child of folder.children) {
      if (child.id === id) return true
      if (child.kind === 'folder' && contains(child, id)) return true
    }
    return false
  }
  return contains(source, candidateFolderId)
}

// ── Seed initial ──────────────────────────────────────────────────────

// Reproduit l'ancien menu IA hardcodé. L'utilisateur peut éditer/supprimer
// librement après le premier boot. Si l'utilisateur supprime tout, on
// n'écrase pas avec le seed (cf. store).
export const DEFAULT_HEADER_BUTTONS: readonly HeaderButton[] = [
  {
    id: 'hb_default_ai',
    label: 'IA',
    color: '#7c3aed',
    entries: [
      {
        kind: 'item',
        id: 'hbe_default_chatgpt',
        label: 'ChatGPT',
        url: 'https://chatgpt.com/',
        tagline: 'OpenAI — GPTs, artifacts, mode vocal'
      },
      {
        kind: 'item',
        id: 'hbe_default_claude',
        label: 'Claude',
        url: 'https://claude.ai/',
        tagline: 'Anthropic — projets, artifacts, longs contextes'
      },
      {
        kind: 'item',
        id: 'hbe_default_gemini',
        label: 'Gemini',
        url: 'https://gemini.google.com/',
        tagline: 'Google — Deep Research, intégration Workspace'
      },
      {
        kind: 'item',
        id: 'hbe_default_perplexity',
        label: 'Perplexity',
        url: 'https://www.perplexity.ai/',
        tagline: 'Recherche web sourcée en temps réel'
      },
      {
        kind: 'item',
        id: 'hbe_default_mistral',
        label: 'Le Chat',
        url: 'https://chat.mistral.ai/',
        tagline: 'Mistral AI — modèles européens, code Codestral'
      },
      {
        kind: 'item',
        id: 'hbe_default_grok',
        label: 'Grok',
        url: 'https://grok.com/',
        tagline: 'xAI — accès direct au flux X / actualité'
      },
      {
        kind: 'item',
        id: 'hbe_default_copilot',
        label: 'Copilot',
        url: 'https://copilot.microsoft.com/',
        tagline: 'Microsoft — recherche Bing intégrée'
      },
      {
        kind: 'item',
        id: 'hbe_default_deepseek',
        label: 'DeepSeek',
        url: 'https://chat.deepseek.com/',
        tagline: 'Modèles open-weights performants en raisonnement'
      },
      {
        kind: 'item',
        id: 'hbe_default_notebooklm',
        label: 'NotebookLM',
        url: 'https://notebooklm.google.com/',
        tagline: 'Google — synthèse audio + Q/R sur tes documents'
      },
      {
        kind: 'item',
        id: 'hbe_default_huggingchat',
        label: 'HuggingChat',
        url: 'https://huggingface.co/chat/',
        tagline: 'HuggingFace — multi-modèles open-source'
      }
    ]
  }
] as const

// Clé SQLite settings pour la persistance.
export const HEADER_BUTTONS_SETTINGS_KEY = 'header.buttons'

// Clé SQLite séparée pour l'état UI "replié" des nœuds (boutons +
// dossiers + sous-dossiers) dans Settings > Navigateur > Boutons du
// Header. Stocké comme JSON `string[]` — liste d'ids actuellement
// repliés ; un Set côté runtime pour les lookups O(1). Couvre les
// boutons (préfixe `hb_`) ET les dossiers (préfixe `hbe_`) dans le
// même Set : pas de collision possible vu les générateurs d'ids
// distincts. Découplé de `header.buttons` car c'est de la préférence
// UI, pas de la donnée métier — éviter de re-écrire tout l'arbre des
// boutons à chaque toggle.
export const HEADER_BUTTONS_COLLAPSED_KEY = 'header.collapsedFolders'

// Aplatit récursivement tous les items terminaux d'une liste de boutons.
// Sert au menu contextuel canvas (vue "Sites" plate de tous les items
// configurés, indépendamment de l'arborescence) et aux compteurs.
export function flattenItems(
  buttons: readonly HeaderButton[]
): Array<{ buttonLabel: string; color: string; item: HeaderButtonItem }> {
  const out: Array<{ buttonLabel: string; color: string; item: HeaderButtonItem }> = []
  function walk(
    entries: readonly HeaderButtonEntry[],
    buttonLabel: string,
    color: string
  ): void {
    for (const e of entries) {
      if (e.kind === 'item') {
        out.push({ buttonLabel, color, item: e })
      } else {
        walk(e.children, buttonLabel, color)
      }
    }
  }
  for (const b of buttons) {
    walk(b.entries, b.label, b.color)
  }
  return out
}
