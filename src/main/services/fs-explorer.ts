import { promises as fs, constants as fsConstants } from 'node:fs'
import { join, basename, dirname, sep, parse as parsePath } from 'node:path'
import { app, shell } from 'electron'

// Service pour l'ExplorerShape : navigation filesystem + actions Windows
// (ouverture native, corbeille, renommage). Tous les chemins sont absolus
// — le renderer ne fournit jamais de chemin relatif. Les erreurs sont
// renvoyées comme `{ ok: false, reason }` plutôt que des throws pour
// permettre au renderer d'afficher un message UX sans try/catch partout.

export interface FsEntry {
  name: string
  // Chemin absolu, séparateurs natifs OS (backslash sur Windows).
  path: string
  isDirectory: boolean
  // Bytes pour les fichiers, 0 pour les dossiers (calculer la taille
  // récursive d'un dossier coûte cher → on évite par défaut).
  size: number
  // Timestamp UNIX en ms — JSON-serializable contrairement à Date.
  modifiedAt: number
  // Extension sans le point (ex: 'txt', 'pdf'). Vide pour dossiers et
  // fichiers sans extension.
  ext: string
  // Fichier/dossier caché (commence par . ou attribut Windows hidden).
  // Pour Windows, on utilise juste le préfixe `.` car l'attribut natif
  // nécessite un appel Win32 (kernel32.GetFileAttributesW) — le préfixe
  // suffit pour la plupart des dotfiles utilisateur.
  hidden: boolean
}

export interface QuickAccessItem {
  // Identifiant interne pour la sidebar (clé React stable).
  id: string
  // Libellé affiché (ex: "Bureau", "Téléchargements").
  label: string
  // Chemin absolu — null si la racine virtuelle "Ce PC" (qui n'est pas
  // un vrai chemin filesystem mais un nœud spécial déclenchant
  // `getDrives` côté renderer).
  path: string | null
  // Icône emoji simple — UI bancale mais évite la dépendance à un set
  // d'icônes complet pour le MVP. v2 pourra remplacer par lucide-react.
  icon: string
}

export interface DriveItem {
  // Lettre + ":\" (Windows) ou point de montage (Linux/macOS).
  path: string
  // Libellé d'affichage (lettre ou nom de volume — v2).
  label: string
}

// ── Listing ───────────────────────────────────────────────────────────

// Liste les entrées d'un dossier. Les erreurs (permission denied, dossier
// inexistant) sont retournées proprement au renderer. Cas spécial Windows :
// chemin = '' ou 'ThisPC' renvoie la liste des disques (vue racine "Ce PC").
export async function listDirectory(
  path: string
): Promise<
  | { ok: true; entries: FsEntry[] }
  | { ok: false; reason: string }
> {
  if (!path || path === 'ThisPC') {
    // Mode racine virtuelle "Ce PC" : on retourne les disques mappés
    // comme des "dossiers" pour que le renderer puisse les afficher
    // dans la liste avec la même UX qu'un dossier normal (double-clic
    // → entre dedans).
    const drives = await listWindowsDrives()
    const entries: FsEntry[] = drives.map((d) => ({
      name: d.label,
      path: d.path,
      isDirectory: true,
      size: 0,
      modifiedAt: 0,
      ext: '',
      hidden: false
    }))
    return { ok: true, entries }
  }

  let dirents: import('node:fs').Dirent[]
  try {
    dirents = await fs.readdir(path, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: errorToReason(err) }
  }

  // Lit le stat de chaque entrée en parallèle (taille, mtime). Les fichiers
  // inaccessibles (lien cassé, permission) sont remplacés par des entrées
  // "fantômes" plutôt que de faire échouer tout le listing — l'utilisateur
  // les voit mais avec size=0 et modifiedAt=0.
  const entries: FsEntry[] = await Promise.all(
    dirents.map(async (d) => {
      const fullPath = join(path, d.name)
      const isDirectory = d.isDirectory()
      const ext = isDirectory ? '' : parsePath(d.name).ext.replace(/^\./, '').toLowerCase()
      try {
        const stat = await fs.stat(fullPath)
        return {
          name: d.name,
          path: fullPath,
          isDirectory,
          size: isDirectory ? 0 : stat.size,
          modifiedAt: stat.mtimeMs,
          ext,
          hidden: d.name.startsWith('.')
        }
      } catch {
        return {
          name: d.name,
          path: fullPath,
          isDirectory,
          size: 0,
          modifiedAt: 0,
          ext,
          hidden: d.name.startsWith('.')
        }
      }
    })
  )

  // Tri par défaut : dossiers d'abord, puis alphabétique insensible à la
  // casse. C'est le comportement standard de l'Explorateur Windows.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return { ok: true, entries }
}

// ── Quick Access (sidebar) ────────────────────────────────────────────

// Dossiers utilisateur standard via `app.getPath` — gère automatiquement
// la localisation du système et les profils déplacés (OneDrive, etc.).
export function getQuickAccess(): QuickAccessItem[] {
  const items: QuickAccessItem[] = [
    { id: 'home', label: 'Accueil', path: app.getPath('home'), icon: '🏠' },
    { id: 'desktop', label: 'Bureau', path: app.getPath('desktop'), icon: '🖥️' },
    { id: 'documents', label: 'Documents', path: app.getPath('documents'), icon: '📄' },
    { id: 'downloads', label: 'Téléchargements', path: app.getPath('downloads'), icon: '⬇️' },
    { id: 'pictures', label: 'Images', path: app.getPath('pictures'), icon: '🖼️' },
    { id: 'music', label: 'Musique', path: app.getPath('music'), icon: '🎵' },
    { id: 'videos', label: 'Vidéos', path: app.getPath('videos'), icon: '🎬' },
    // Nœud virtuel "Ce PC" : le renderer affiche la liste des disques
    // quand on clique dessus. path=null pour le distinguer.
    { id: 'thispc', label: 'Ce PC', path: null, icon: '💻' }
  ]
  return items
}

// ── Drives Windows ────────────────────────────────────────────────────

// Énumère les disques montés via test d'accès parallèle sur les 26 lettres.
// Approche cross-version (pas besoin de WMIC qui est deprecated Win11) et
// ~50 ms de latence acceptable. Les lettres invalides échouent en
// ENOENT/EBUSY/etc. silencieusement — on garde uniquement celles qui
// répondent à `fs.access(R_OK)`.
async function listWindowsDrives(): Promise<DriveItem[]> {
  if (process.platform !== 'win32') {
    // Linux/macOS : retourne la racine seule. Pas de support multi-mount
    // pour le MVP — l'utilisateur navigue manuellement via la sidebar.
    return [{ path: '/', label: '/' }]
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const checks = letters.map(async (letter) => {
    const drivePath = `${letter}:\\`
    try {
      await fs.access(drivePath, fsConstants.R_OK)
      return { path: drivePath, label: `${letter}:` }
    } catch {
      return null
    }
  })
  const results = await Promise.all(checks)
  return results.filter((r): r is DriveItem => r !== null)
}

// ── Actions ───────────────────────────────────────────────────────────

// Ouvre un fichier avec l'application par défaut Windows. Pour un dossier,
// `shell.openPath` lance l'Explorateur natif sur ce dossier — ce qui peut
// ÊTRE désiré (ouvrir-natif) mais le renderer doit décider : pour un
// double-clic dossier dans NOTRE UI, il navigue dedans (ne nous appelle
// pas). Pour "Ouvrir dans l'Explorateur natif" (menu contextuel), il
// nous appelle avec le chemin du dossier.
export async function openFile(
  path: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await shell.openPath(path)
  if (result === '') return { ok: true }
  // shell.openPath retourne un message d'erreur en string (vide = succès).
  return { ok: false, reason: result }
}

// Renomme une entrée (fichier ou dossier). Le nouveau nom ne doit pas
// contenir de séparateur — on rebuild le chemin complet côté main pour
// éviter une attaque type "../escape".
export async function renameEntry(
  oldPath: string,
  newName: string
): Promise<{ ok: true; newPath: string } | { ok: false; reason: string }> {
  if (!newName || newName.includes(sep) || newName.includes('/') || newName === '.' || newName === '..') {
    return { ok: false, reason: 'nom-invalide' }
  }
  const parent = dirname(oldPath)
  const newPath = join(parent, newName)
  try {
    await fs.rename(oldPath, newPath)
    return { ok: true, newPath }
  } catch (err) {
    return { ok: false, reason: errorToReason(err) }
  }
}

// Envoie une entrée à la corbeille système (réversible côté utilisateur
// via Restaurer dans la corbeille Windows). Beaucoup plus sûr que
// `fs.rm` qui supprime définitivement — un clic accidentel n'est pas
// catastrophique.
export async function trashEntry(
  path: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await shell.trashItem(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: errorToReason(err) }
  }
}

// Lance l'Explorateur Windows sur ce dossier (ou met en surbrillance le
// fichier dans son dossier parent). Pour un dossier, on ouvre dedans ;
// pour un fichier, on highlight via `showItemInFolder`.
export async function openInNativeExplorer(
  path: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const stat = await fs.stat(path)
    if (stat.isDirectory()) {
      const result = await shell.openPath(path)
      if (result === '') return { ok: true }
      return { ok: false, reason: result }
    }
    shell.showItemInFolder(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: errorToReason(err) }
  }
}

// ── Lecture/écriture texte (NotepadShape) ─────────────────────────────

// Limite max pour la lecture en NotepadShape : 5 Mo. Au-delà, c'est sans
// doute pas un fichier texte (binaire mal nommé) ou trop gros pour un
// éditeur "bloc-notes" — VSCode est mieux placé pour ça.
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024

// Lit un fichier texte UTF-8 et retourne son contenu. Refuse les fichiers
// trop gros et les chemins inexistants. Pas de sandboxing du chemin :
// l'utilisateur choisit explicitement quoi ouvrir (clic dans Explorer,
// double-clic sur .txt, …) — le risque de path traversal est nul.
export async function readTextFile(
  path: string
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  try {
    const stat = await fs.stat(path)
    if (stat.isDirectory()) return { ok: false, reason: 'ENOTDIR' }
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return { ok: false, reason: 'fichier-trop-gros' }
    }
    const content = await fs.readFile(path, 'utf-8')
    return { ok: true, content }
  } catch (err) {
    return { ok: false, reason: errorToReason(err) }
  }
}

// Écrit un fichier texte UTF-8. Crée le fichier s'il n'existe pas (pour
// permettre le « Save As » futur). Pas de backup pour le moment — on
// fait confiance à l'auto-save debounce qui ne fire qu'après inactivité.
export async function writeTextFile(
  path: string,
  content: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await fs.writeFile(path, content, 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: errorToReason(err) }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

// Normalise les erreurs Node en codes courts pour le renderer. Les codes
// errno (ENOENT, EACCES, EBUSY) sont déjà des chaînes lisibles — on les
// passe tels quels. Pour les autres erreurs, on garde le `.message`.
function errorToReason(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code
  }
  if (err instanceof Error) return err.message
  return String(err)
}

// Re-export pour le renderer : permet d'afficher des chemins qui ne sont
// PAS résolvables (par ex. quand l'utilisateur tape un chemin inexistant
// dans la path bar, on affiche le message d'erreur courte).
export { basename, dirname }
