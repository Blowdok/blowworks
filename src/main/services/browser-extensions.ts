import { session, app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  cpSync,
  rmSync
} from 'node:fs'
import { join, basename } from 'node:path'

// Gestion des extensions Chrome chargées dans la partition `persist:browser`
// (utilisée par tous les webviews du navigateur intégré).
//
// Stratégie :
//   - userData/extensions/<id>/ contient un dossier d'extension décompressé
//     (manifest.json à la racine).
//   - Au boot, on scanne ce dossier et on `loadExtension()` chacune.
//   - L'utilisateur peut ajouter une extension via "Choisir un dossier" :
//     on COPIE le dossier source dans userData/extensions/ avant de charger.
//     Ainsi les extensions survivent même si l'utilisateur déplace/supprime
//     le dossier source d'origine.
//   - Désinstallation = removeExtension() + suppression du dossier disque.
//
// MV2 : pleinement supporté.
// MV3 : support partiel (service workers OK, certains chrome.* APIs limités).
//       Cohérent avec l'état actuel d'Electron 30+.

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  path: string
  manifestUrl: string | null
}

function extensionsDir(): string {
  const dir = join(app.getPath('userData'), 'extensions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readManifest(folder: string): { name?: string; version?: string } | null {
  const manifestPath = join(folder, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const raw = readFileSync(manifestPath, 'utf-8')
    return JSON.parse(raw) as { name?: string; version?: string }
  } catch {
    return null
  }
}

let attached = false

// Charge toutes les extensions présentes dans userData/extensions/.
// Idempotent : ne s'exécute qu'une fois par démarrage.
export async function loadExtensionsAtBoot(): Promise<void> {
  if (attached) return
  attached = true

  const dir = extensionsDir()
  const ses = session.fromPartition('persist:browser')

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const folder = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(folder).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    if (!readManifest(folder)) continue

    try {
      // `allowFileAccess: true` permet aux extensions d'accéder à des
      // file:// URLs (utile pour des extensions de dev). Sinon Chromium
      // refuse l'accès par défaut (comportement Chrome).
      // `session.extensions.*` (introduit en Electron 35+) remplace les
      // anciennes méthodes `session.loadExtension` etc. — mêmes signatures,
      // juste un namespace dédié pour regrouper les APIs extensions.
      await ses.extensions.loadExtension(folder, { allowFileAccess: true })
    } catch (err) {
      console.warn(`[browser-extensions] Échec chargement ${entry}`, err)
    }
  }
}

export function listExtensions(): ExtensionInfo[] {
  const ses = session.fromPartition('persist:browser')
  const all = ses.extensions.getAllExtensions()
  return all.map((ext) => ({
    id: ext.id,
    name: ext.name,
    version: ext.version,
    path: ext.path,
    manifestUrl: ext.url ?? null
  }))
}

// Charge une extension depuis un chemin externe : on la COPIE dans
// userData/extensions/<basename>/ pour qu'elle survive aux mouvements
// de fichiers de l'utilisateur, puis on appelle loadExtension sur la
// copie. Renvoie un objet de résultat structuré (pas d'exception remontée
// au renderer pour garder l'UI résiliente).
export async function loadExtensionFromFolder(
  sourcePath: string
): Promise<
  | { ok: true; id: string; name: string; version: string }
  | { ok: false; error: string }
> {
  if (!existsSync(sourcePath)) {
    return { ok: false, error: 'Dossier introuvable.' }
  }
  const manifest = readManifest(sourcePath)
  if (!manifest) {
    return { ok: false, error: 'manifest.json absent ou invalide.' }
  }

  const dir = extensionsDir()
  const target = join(dir, basename(sourcePath))

  // Si une extension du même nom existe déjà → erreur explicite plutôt
  // qu'écrasement silencieux.
  if (existsSync(target)) {
    return {
      ok: false,
      error: `Une extension du même nom existe déjà : ${basename(target)}`
    }
  }

  try {
    cpSync(sourcePath, target, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      error: `Copie échouée : ${(err as Error).message}`
    }
  }

  try {
    const ses = session.fromPartition('persist:browser')
    const ext = await ses.extensions.loadExtension(target, { allowFileAccess: true })
    return { ok: true, id: ext.id, name: ext.name, version: ext.version }
  } catch (err) {
    // Cleanup en cas d'échec — on ne laisse pas un dossier orphelin
    // qui re-tentera de charger au prochain boot.
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      error: `Chargement Electron échoué : ${(err as Error).message}`
    }
  }
}

// Désinstalle : supprime de la session ET du disque.
export function removeExtensionById(id: string): { ok: boolean; error?: string } {
  const ses = session.fromPartition('persist:browser')
  const ext = ses.extensions.getAllExtensions().find((e) => e.id === id)
  if (!ext) return { ok: false, error: 'Extension introuvable.' }

  ses.extensions.removeExtension(id)
  try {
    rmSync(ext.path, { recursive: true, force: true })
  } catch (err) {
    return {
      ok: false,
      error: `Désinstallée mais suppression disque échouée : ${(err as Error).message}`
    }
  }
  return { ok: true }
}
