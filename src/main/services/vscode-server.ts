import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getDb } from './db.js'

// Gestion du sidecar openvscode-server : spawn unique, port fixe, token auth.

// Port FIXE pour le sidecar VSCode. Nécessaire car :
// - L'iframe charge `http://127.0.0.1:<port>/`. L'origin = host+port.
// - localStorage, IndexedDB et les SecretStorage du workbench web sont
//   scopés par origin (garantie navigateur).
// - Un port aléatoire à chaque démarrage ⇒ nouvel origin ⇒ storage réinitialisé
//   ⇒ re-authentification GitHub exigée à chaque lancement de BlowWorks.
// Port choisi hors des plages bien connues de dev (loin de 3000/5173/8080
// pour éviter les collisions courantes).
const VSCODE_FIXED_PORT = 27338

interface ServerState {
  running: boolean
  port: number | null
  token: string | null
  proc: ChildProcess | null
}

class VSCodeServer {
  private state: ServerState = { running: false, port: null, token: null, proc: null }
  private startPromise: Promise<void> | null = null
  // Dernier diagnostic d'échec remonté au renderer (raison + extrait stderr).
  private lastError: string | null = null

  async ensureStarted(): Promise<ServerState> {
    if (this.state.running) return this.getPublicStatus()
    if (!this.startPromise) this.startPromise = this.start()
    await this.startPromise
    return this.getPublicStatus()
  }

  getLastError(): string | null {
    return this.lastError
  }

  getPublicStatus() {
    return {
      running: this.state.running,
      port: this.state.port,
      token: this.state.token,
      proc: null as null
    }
  }

  async stop(): Promise<void> {
    if (this.state.proc && !this.state.proc.killed) {
      this.state.proc.kill()
    }
    this.state = { running: false, port: null, token: null, proc: null }
    this.startPromise = null
  }

  // Redémarre le sidecar : nécessaire quand le PAT GitHub change (pour
  // propager la nouvelle env var `GITHUB_TOKEN` aux extensions). Les iframes
  // ouvertes rechargeront automatiquement (origin identique car port fixe).
  async restart(): Promise<void> {
    await this.stop()
    await this.ensureStarted()
  }

  private async start(): Promise<void> {
    const resolved = this.resolveBinary()
    if (!resolved) {
      console.warn('[vscode-server] binaire VSCode/openvscode-server absent — VSCode désactivé.')
      return
    }

    // Pré-test rapide : le port fixe est-il disponible ? Si occupé par un
    // autre processus, on remonte tout de suite un diagnostic lisible plutôt
    // que de laisser VSCode échouer 45s plus tard sur un port collision.
    const available = await isPortAvailable(VSCODE_FIXED_PORT)
    if (!available) {
      const msg = `Port ${VSCODE_FIXED_PORT} déjà occupé par un autre processus. Fermez-le puis relancez BlowWorks.`
      console.error('[vscode-server]', msg)
      this.lastError = msg
      this.startPromise = null
      return
    }
    const port = VSCODE_FIXED_PORT
    // Token conservé pour le contrat IPC mais inutilisé côté URL : le serveur
    // VSCode est lié exclusivement à 127.0.0.1 + frame-src CSP limité à la
    // même origine. Passer `--without-connection-token` évite les 403 dus à
    // un éventuel décalage entre notre token et celui auto-généré.
    const token = randomBytes(24).toString('hex')

    // Isolation stricte vis-à-vis du VSCode installé de l'utilisateur :
    // `code-tunnel.exe serve-web` (backend actuel de `Code.exe serve-web`)
    // accepte UNIQUEMENT `--server-data-dir` — les flags IDE classiques
    // `--user-data-dir` et `--extensions-dir` ne sont PAS reconnus et
    // provoquent un exit immédiat (`error: unexpected argument`). Ce
    // répertoire contient à la fois les données serveur et les extensions.
    // On l'isole sous userData de BlowWorks pour éviter tout partage avec
    // l'instance VSCode de l'utilisateur.
    const serverDataDir = join(app.getPath('userData'), 'openvscode-server-data')
    mkdirSync(serverDataDir, { recursive: true })

    // Installation de l'extension `blowworks-auth` qui enregistre un
    // AuthenticationProvider pour l'id `github` à la place de l'extension
    // native désactivée (cf. `--disable-extension` dans les args baseArgs).
    // Le PAT courant est propagé via un fichier `pat.txt` adjacent — lu
    // par l'extension au démarrage et surveillé via fs.watch pour les
    // mises à jour à chaud.
    const authExtensionDir = installAuthExtension(serverDataDir)
    const ghToken = readStoredGitHubToken()
    writePatFile(authExtensionDir, ghToken)

    // Désactive les extensions user qui sont cassées sur Code.exe serve-web
    // (Node 22 + sandbox extensionHost) ou qui spamment des appels vers
    // des endpoints inexistants. Idempotent — restaurable manuellement en
    // renommant `package.json.blowworks-disabled` → `package.json`.
    disableBrokenUserExtensions(serverDataDir)

    const isWin = process.platform === 'win32'

    // Sur Windows, pour invoquer la sous-commande `serve-web` SANS ouvrir
    // l'UI graphique, il faut reproduire ce que fait `bin/code.cmd` :
    //   ELECTRON_RUN_AS_NODE=1  Code.exe  <cli.js>  serve-web  ...args
    // Sans ELECTRON_RUN_AS_NODE et cli.js, Code.exe démarre en mode IDE et
    // ouvre une fenêtre — c'est exactement le symptôme rapporté.
    // `--without-connection-token` = flag booléen qui désactive l'auth par
    // token. Acceptable car : bind 127.0.0.1 uniquement + CSP `frame-src` +
    // sandbox renderer limitent l'accès à notre seul iframe.
    // `code-tunnel.exe serve-web` n'accepte PAS `--disable-extension`
    // (validé 2026-04-21 : `error: unexpected argument`). On neutralise donc
    // l'extension native `vscode.github-authentication` en renommant son
    // `package.json` directement dans le binaire VSCode → VSCode skip le
    // chargement (un dossier d'extension sans manifest est ignoré). Notre
    // `blowworks-auth` peut alors enregistrer l'id `github` sans conflit.
    disableBuiltinGitHubAuth(resolved.cliJs!)

    // Bascule le marketplace par défaut (Microsoft, restreint aux builds
    // VSCode signés) vers OpenVSX pour que l'install/update d'extensions
    // depuis l'UI VSCode embarquée fonctionne. Microsoft renvoie 403/404
    // sur leur gallery quand on tape depuis Code.exe + serve-web non
    // officiel — OpenVSX accepte tout client.
    patchProductJsonForOpenVSX(resolved.cliJs!)

    const baseArgs = [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--without-connection-token',
      '--accept-server-license-terms',
      '--server-data-dir',
      serverDataDir
    ]

    // Force le locale anglais sur le serveur VSCode : évite l'erreur
    // "NLS MISSING: XXXXX" quand le pack de langue système (fr-FR) n'a pas
    // toutes les clés que le workbench web consulte → sinon iframe noir.
    const localeEnv = {
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LANGUAGE: 'en_US:en',
      VSCODE_NLS_CONFIG: JSON.stringify({
        locale: 'en',
        osLocale: 'en',
        availableLanguages: {}
      })
    }

    // Injection du PAT GitHub dans l'environnement. `GITHUB_TOKEN` est lu
    // par `VSCODE_GIT_ASKPASS` (opérations git CLI : clone/push/pull sans
    // prompt) ; `GH_TOKEN` est l'alias canonique de la GitHub CLI. Ce
    // mécanisme est complémentaire de l'extension `blowworks-auth` (qui
    // couvre, elle, l'UI de login et Copilot via l'API
    // `vscode.authentication`). On réutilise le token lu plus haut.
    const ghEnv: NodeJS.ProcessEnv = ghToken
      ? { GITHUB_TOKEN: ghToken, GH_TOKEN: ghToken }
      : {}

    let binary: string
    let args: string[]
    let env: NodeJS.ProcessEnv
    if (isWin) {
      binary = resolved.exe
      args = [resolved.cliJs!, 'serve-web', ...baseArgs]
      env = { ...process.env, ...localeEnv, ...ghEnv, ELECTRON_RUN_AS_NODE: '1' }
    } else {
      binary = resolved.exe
      args = baseArgs
      env = { ...process.env, ...localeEnv, ...ghEnv }
    }

    console.log('[vscode-server] spawn', binary, 'port=', port, 'serverData=', serverDataDir)

    const proc = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: false,
      env,
      // Windowless : empêche l'ouverture d'une console flash pour un cli Node.
      windowsHide: true
    })

    // Buffer circulaire des dernières lignes stderr : utile pour remonter
    // une raison d'échec lisible au renderer en cas de timeout / exit prématuré.
    const stderrTail: string[] = []
    proc.stdout?.on('data', (d) => console.log('[vscode-server]', d.toString().trim()))
    proc.stderr?.on('data', (d) => {
      const line = d.toString().trim()
      console.error('[vscode-server]', line)
      stderrTail.push(line)
      if (stderrTail.length > 20) stderrTail.shift()
    })
    proc.on('exit', (code) => {
      console.log('[vscode-server] sorti code=', code)
      if (!this.state.running && code !== 0) {
        this.lastError = `sidecar sorti (code=${code}) — ${stderrTail.slice(-3).join(' | ') || 'stderr vide'}`
      }
      this.state = { running: false, port: null, token: null, proc: null }
      this.startPromise = null
    })

    // Healthcheck actif : on sonde le port TCP jusqu'à ce qu'il accepte la
    // connexion. Indispensable pour éviter qu'un iframe se charge trop tôt,
    // reçoive ERR_CONNECTION_REFUSED et soit verrouillé sur `chrome-error://`
    // (Chromium refuse ensuite toute navigation cross-origin depuis ce frame).
    // Timeout 45s : sur Windows, le premier démarrage de Code.exe avec un
    // `--user-data-dir` neuf (création des bases SQLite internes, init
    // extensions) peut dépasser 20s.
    const ready = await waitForPort(port, 45000)
    if (!ready) {
      const tail = stderrTail.slice(-5).join(' | ') || '(stderr vide — binaire muet)'
      console.error('[vscode-server] timeout 45s — stderr:', tail)
      this.lastError = `timeout 45s — ${tail}`
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      // Reset explicite : sans ça, `ensureStarted()` verrait state.running===false
      // mais startPromise toujours résolue → boucle infinie "Démarrage…".
      this.state = { running: false, port: null, token: null, proc: null }
      this.startPromise = null
      return
    }

    // Succès : on efface tout diagnostic d'échec précédent.
    this.lastError = null
    this.state = { running: true, port, token, proc }
  }

  private resolveBinary(): { exe: string; cliJs: string | null } | null {
    // Windows : Code.exe + <commit-sha>/resources/app/out/cli.js.
    //   Le commit-sha varie selon la version téléchargée (ex: 560a9dba96).
    //   On le découvre en listant la racine et en cherchant le dossier qui
    //   contient cli.js.
    // Linux/macOS : binaire natif `openvscode-server` dans bin/, pas de cli.js.
    const isWin = process.platform === 'win32'
    const rootCandidates = is.dev
      ? [join(app.getAppPath(), 'resources', 'openvscode-server')]
      : [join(process.resourcesPath, 'openvscode-server')]

    for (const root of rootCandidates) {
      if (isWin) {
        const exe = join(root, 'Code.exe')
        if (!existsSync(exe)) continue
        const cliJs = findCliJs(root)
        if (!cliJs) {
          console.warn('[vscode-server] Code.exe trouvé mais cli.js introuvable sous', root)
          continue
        }
        return { exe, cliJs }
      } else {
        const exe = join(root, 'bin', 'openvscode-server')
        if (existsSync(exe)) return { exe, cliJs: null }
      }
    }
    return null
  }
}

export const vscodeServer = new VSCodeServer()

// Lit le PAT GitHub chiffré dans les settings SQLite et le déchiffre via
// safeStorage (DPAPI sur Windows). Retourne `null` si :
//   - aucun PAT stocké, safeStorage indisponible, ou déchiffrement échoué
//   - OU si l'utilisateur s'est "déconnecté soft" : le PAT chiffré reste
//     en DB pour la reconnexion rapide (cf. `GitHubAccount.tsx`) mais le
//     profil (`github.user.json`) a été supprimé → session inactive.
//     Sans cette vérification, VSCode verrait une session active même
//     après que l'utilisateur a cliqué "Se déconnecter".
function readStoredGitHubToken(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const db = getDb()
    // Check d'abord que le profil est présent (session active).
    const profileRow = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('github.user.json') as { value: string } | undefined
    if (!profileRow?.value) return null

    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('github.pat.encrypted') as { value: string } | undefined
    if (!row?.value) return null
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
  } catch (err) {
    console.error('[vscode-server] échec lecture PAT GitHub :', err)
    return null
  }
}

// Neutralise l'extension native `vscode.github-authentication` pour laisser
// `blowworks-auth` enregistrer l'id `github` sans conflit ("already been
// registered"). Nécessaire car `code-tunnel.exe serve-web` ne supporte PAS
// `--disable-extension`.
//
// IMPORTANT : `Code.exe serve-web` n'exécute PAS depuis `resources/openvscode-server/`
// mais depuis une copie auto-extraite dans `%USERPROFILE%\.vscode\cli\serve-web\<commit-complet>\`.
// Il faut donc renommer le `package.json` de l'extension native dans CE
// dossier-là — sinon la native se charge quand même au boot.
//
// On patche les DEUX endroits :
//   1. `%USERPROFILE%\.vscode\cli\serve-web\<commit>\...` : ce qui est
//      réellement chargé au runtime. Si absent (cold start, pas encore
//      extrait), on ne peut rien faire — l'user devra relancer une fois.
//   2. `resources/openvscode-server/<commit-short>/...` : source utilisée
//      par VSCode pour extraire vers (1). Ainsi toute future extraction
//      héritera du rename.
//
// Idempotent : check `existsSync(backup)` avant chaque rename. Restaurable
// en renommant `package.json.blowworks-backup` → `package.json`.
function disableBuiltinGitHubAuth(cliJs: string): void {
  const targets: string[] = []

  // Cible #1 : cache user `%USERPROFILE%\.vscode\cli\serve-web\<commit>\`.
  // Structure RÉELLE (validée sur disque 2026-04-21) : les extensions sont
  // directement sous `<commit>/extensions/`, SANS `resources/app/` intermédiaire
  // — contrairement à la source bundlée (cible #2). On parcourt tous les
  // commits extraits (chaque version VSCode en crée un).
  try {
    const userCacheRoot = join(app.getPath('home'), '.vscode', 'cli', 'serve-web')
    if (existsSync(userCacheRoot)) {
      for (const entry of readdirSync(userCacheRoot)) {
        const candidate = join(userCacheRoot, entry, 'extensions', 'github-authentication')
        if (existsSync(candidate)) targets.push(candidate)
      }
    }
  } catch (err) {
    console.error('[vscode-server] scan ~/.vscode/cli/serve-web échoué :', err)
  }

  // Cible #2 : source bundlée `resources/openvscode-server/<commit-short>/`.
  // `cliJs` = `.../resources/openvscode-server/<commit-short>/resources/app/out/cli.js`
  // → on remonte à `.../resources/app/extensions/github-authentication`.
  try {
    const appDir = dirname(dirname(cliJs))
    const bundled = join(appDir, 'extensions', 'github-authentication')
    if (existsSync(bundled)) targets.push(bundled)
  } catch (err) {
    console.error('[vscode-server] résolution extension bundlée échouée :', err)
  }

  if (targets.length === 0) {
    console.warn(
      '[vscode-server] aucune extension github-authentication trouvée — cold start ? Relancez après première extraction.'
    )
    return
  }

  for (const extDir of targets) {
    try {
      const pkg = join(extDir, 'package.json')
      const backup = join(extDir, 'package.json.blowworks-backup')
      if (existsSync(backup)) continue // déjà neutralisée
      if (existsSync(pkg)) {
        renameSync(pkg, backup)
        console.log('[vscode-server] github-authentication neutralisée :', extDir)
      }
    } catch (err) {
      console.error('[vscode-server] rename échoué pour', extDir, ':', err)
    }
  }
}

// Endpoints OpenVSX (registry alternatif compatible avec l'API gallery
// de Microsoft). Catalogue ~80% des extensions populaires ; manque les
// exclusives Microsoft (Pylance, Remote-SSH, Live Share).
const OPENVSX_GALLERY = {
  serviceUrl: 'https://open-vsx.org/vscode/gallery',
  itemUrl: 'https://open-vsx.org/vscode/item',
  resourceUrlTemplate:
    'https://open-vsx.org/api/{publisher}/{name}/{version}/file/{path}',
  controlUrl: '',
  recommendationsUrl: ''
} as const

// Patch le `product.json` pour rediriger les requêtes marketplace vers
// OpenVSX. Idempotent : on ne ré-écrit pas si la cible OpenVSX est déjà
// active. Sauvegarde l'original dans `product.json.blowworks-backup` pour
// permettre un restore manuel.
//
// Comme `disableBuiltinGitHubAuth`, on patche les DEUX endroits :
//   1. Cache user `~/.vscode/cli/serve-web/<commit-long>/product.json`
//      = ce qui est réellement chargé au runtime.
//   2. Source bundlée `<root>/<commit-short>/resources/app/product.json`
//      = utilisé par VSCode pour ré-extraire vers (1) après update.
function patchProductJsonForOpenVSX(cliJs: string): void {
  const targets: string[] = []

  // Cible #1 : cache user (chemin direct, pas de `resources/app/` intermédiaire).
  try {
    const userCacheRoot = join(app.getPath('home'), '.vscode', 'cli', 'serve-web')
    if (existsSync(userCacheRoot)) {
      for (const entry of readdirSync(userCacheRoot)) {
        const candidate = join(userCacheRoot, entry, 'product.json')
        if (existsSync(candidate)) targets.push(candidate)
      }
    }
  } catch (err) {
    console.error('[vscode-server] scan product.json (cache) échoué :', err)
  }

  // Cible #2 : source bundlée à côté de `out/cli.js`.
  try {
    const appDir = dirname(dirname(cliJs))
    const bundled = join(appDir, 'product.json')
    if (existsSync(bundled)) targets.push(bundled)
  } catch (err) {
    console.error('[vscode-server] résolution product.json bundlé échouée :', err)
  }

  if (targets.length === 0) {
    console.warn(
      '[vscode-server] aucun product.json trouvé — cold start ? Le marketplace OpenVSX sera actif au prochain démarrage.'
    )
    return
  }

  for (const productPath of targets) {
    try {
      const raw = readFileSync(productPath, 'utf8')
      let parsed: { extensionsGallery?: { serviceUrl?: string } } & Record<string, unknown>
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        console.error('[vscode-server] product.json invalide :', productPath, err)
        continue
      }

      // Idempotence : déjà patché ? on skip.
      if (parsed.extensionsGallery?.serviceUrl === OPENVSX_GALLERY.serviceUrl) {
        continue
      }

      // Backup une seule fois : si déjà fait, on ne réécrase pas
      // l'original (qui contient les vrais URLs Microsoft).
      const backupPath = `${productPath}.blowworks-backup`
      if (!existsSync(backupPath)) {
        writeFileSync(backupPath, raw, 'utf8')
      }

      parsed.extensionsGallery = { ...OPENVSX_GALLERY }
      writeFileSync(productPath, JSON.stringify(parsed, null, 2), 'utf8')
      console.log('[vscode-server] product.json basculé vers OpenVSX :', productPath)
    } catch (err) {
      console.error('[vscode-server] patch product.json échoué pour', productPath, ':', err)
    }
  }
}

// Désactive les extensions user présentes dans `<serverDataDir>/extensions/`
// qui plantent sur Code.exe serve-web ou polluent la console. Méthode :
// renommer `package.json` → `package.json.blowworks-disabled` (VSCode skip
// les dossiers d'extensions sans manifest).
//
// Patterns désactivés (préfixes — la version à la fin varie) :
//   - `github.copilot-chat-` : `PendingMigrationError: navigator is now a
//     global` au démarrage (bug Node 22 dans copilot-chat ≤ 0.45.x), plus
//     une rafale de 404 sur `api.github.com/copilot/mcp_registry`. Tant
//     que Microsoft n'a pas patché, l'extension est inutilisable et
//     remplit le log d'erreurs.
//
// Pour réactiver une extension désactivée : renommer manuellement
// `package.json.blowworks-disabled` → `package.json` dans le dossier
// `<userData>/openvscode-server-data/extensions/<id>-<version>/`.
const DISABLED_USER_EXTENSIONS = ['github.copilot-chat-']

function disableBrokenUserExtensions(serverDataDir: string): void {
  const extDir = join(serverDataDir, 'extensions')
  if (!existsSync(extDir)) return
  let entries: string[]
  try {
    entries = readdirSync(extDir)
  } catch (err) {
    console.error('[vscode-server] scan extensions user échoué :', err)
    return
  }
  for (const entry of entries) {
    const matched = DISABLED_USER_EXTENSIONS.some((prefix) => entry.startsWith(prefix))
    if (!matched) continue
    const pkg = join(extDir, entry, 'package.json')
    const backup = join(extDir, entry, 'package.json.blowworks-disabled')
    if (existsSync(backup)) continue // déjà désactivée
    if (!existsSync(pkg)) continue
    try {
      renameSync(pkg, backup)
      console.log('[vscode-server] extension désactivée (broken/spammy) :', entry)
    } catch (err) {
      console.error('[vscode-server] désactivation échouée pour', entry, ':', err)
    }
  }
}

// Copie (ou met à jour) l'extension `blowworks-auth` dans le dossier
// `<serverDataDir>/extensions/blowworks-auth-1.0.0/` pour qu'elle soit
// chargée automatiquement au démarrage du workbench. Retourne le chemin
// du dossier cible, utilisé ensuite par `writePatFile`.
function installAuthExtension(serverDataDir: string): string {
  const sourceRoot = is.dev
    ? join(app.getAppPath(), 'resources', 'blowworks-auth-extension')
    : join(process.resourcesPath, 'blowworks-auth-extension')
  const targetDir = join(serverDataDir, 'extensions', 'blowworks-auth-1.0.0')
  mkdirSync(targetDir, { recursive: true })
  // Copie des 2 fichiers sources. Idempotent : on écrase à chaque démarrage
  // pour propager les mises à jour lors d'un upgrade de BlowWorks.
  for (const file of ['package.json', 'extension.js']) {
    const from = join(sourceRoot, file)
    const to = join(targetDir, file)
    if (existsSync(from)) {
      copyFileSync(from, to)
    } else {
      console.warn('[vscode-server] extension source introuvable :', from)
    }
  }
  return targetDir
}

// Écrit le PAT brut dans `<authExtensionDir>/pat.txt` pour que l'extension
// puisse l'offrir comme session GitHub. Si `token` est null (déconnexion),
// le fichier est supprimé — l'extension retournera alors `getSessions([])`
// et le workbench affichera de nouveau le bouton "Sign in".
export function writePatFile(authExtensionDir: string, token: string | null): void {
  const patFile = join(authExtensionDir, 'pat.txt')
  try {
    if (token && token.length > 0) {
      writeFileSync(patFile, token, { encoding: 'utf8', mode: 0o600 })
    } else if (existsSync(patFile)) {
      rmSync(patFile, { force: true })
    }
  } catch (err) {
    console.error('[vscode-server] écriture pat.txt échouée :', err)
  }
}

// Chemin du dossier de l'extension installée — utile aux appelants qui
// veulent mettre à jour `pat.txt` sans redémarrer le sidecar (changement
// de token à chaud). Construit sur la même base que `installAuthExtension`.
export function getAuthExtensionDir(): string {
  return join(app.getPath('userData'), 'openvscode-server-data', 'extensions', 'blowworks-auth-1.0.0')
}

// Localise `resources/app/out/cli.js` sous un dossier racine VSCode portable.
// Le chemin exact dépend du commit SHA de la version téléchargée (dossier
// nommé avec un hash court ex: `560a9dba96`).
function findCliJs(root: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = join(root, entry, 'resources', 'app', 'out', 'cli.js')
    if (existsSync(candidate)) return candidate
  }
  return null
}

// Teste la disponibilité d'un port TCP précis sur 127.0.0.1 : résout `true`
// si on peut y binder (donc libre), `false` sinon (typiquement EADDRINUSE).
// Le serveur est immédiatement refermé après le test — VSCode pourra rebinder.
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, '127.0.0.1')
  })
}

// Polling TCP : résout `true` dès que le port accepte une connexion, `false`
// si le timeout expire. Sonde toutes les 200 ms.
function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tryConnect = (): void => {
      const sock = createConnection({ host: '127.0.0.1', port })
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() >= deadline) {
          resolve(false)
          return
        }
        setTimeout(tryConnect, 200)
      })
    }
    tryConnect()
  })
}
