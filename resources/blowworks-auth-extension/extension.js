// Extension BlowWorks Auth : enregistre un AuthenticationProvider pour l'id
// "github" (en lieu et place de vscode.github-authentication qui est désactivé
// via --disable-extension dans vscode-server.ts côté main BlowWorks).
//
// Source du PAT : fichier `pat.txt` écrit à côté de ce module par BlowWorks
// juste avant le spawn du sidecar. Le fichier contient uniquement la chaîne
// du token (pas de JSON) pour minimiser la surface d'attaque en cas de leak.
//
// Quand le PAT change (setToken/disconnect dans l'UI BlowWorks), le fichier
// est réécrit puis le sidecar est redémarré — les iframes rechargent, la
// nouvelle session est propagée à toutes les extensions qui appellent
// `vscode.authentication.getSession('github', ...)`.

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const https = require('https')

// Guard module-level : VSCode peut activer l'extension plusieurs fois dans
// certains scénarios (extensionKind multi-contexts, reload iframe). Le
// second appel à `registerAuthenticationProvider('github', ...)` jetterait
// `This authentication id 'github' has already been registered`. On skip
// proprement si on a déjà un disposable actif.
let providerDisposable = null

function activate(context) {
  if (providerDisposable) {
    // Déjà actif dans ce process Node : rien à refaire. On push quand même
    // le disposable dans les subscriptions pour que VSCode nettoie au
    // dispose de la nouvelle instance context.
    context.subscriptions.push(providerDisposable)
    return
  }
  const patFile = path.join(context.extensionPath, 'pat.txt')
  const emitter = new vscode.EventEmitter()
  let cachedSession = null

  function readPAT() {
    try {
      if (!fs.existsSync(patFile)) return null
      const raw = fs.readFileSync(patFile, 'utf8').trim()
      return raw.length > 0 ? raw : null
    } catch (err) {
      console.error('[blowworks-auth] lecture pat.txt impossible :', err)
      return null
    }
  }

  function fetchUser(pat) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.github.com',
          path: '/user',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${pat}`,
            'User-Agent': 'BlowWorks-Auth',
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          timeout: 8000
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`GitHub API HTTP ${res.statusCode}`))
              return
            }
            try {
              resolve(JSON.parse(body))
            } catch (err) {
              reject(err)
            }
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error('timeout fetch /user'))
      })
      req.end()
    })
  }

  // Construit une session à partir du PAT actuel. Résolue à `null` si
  // aucun PAT n'est configuré. En cas d'échec d'appel GitHub API (offline,
  // DNS bloqué), retourne quand même une session "minimale" — Copilot
  // continuera probablement à échouer mais au moins l'UI de login ne sera
  // pas ré-affichée en boucle.
  async function buildSession() {
    const pat = readPAT()
    if (!pat) {
      cachedSession = null
      return null
    }
    if (cachedSession && cachedSession.accessToken === pat) {
      return cachedSession
    }
    let account = { id: 'blowworks-user', label: 'blowworks-user' }
    try {
      const user = await fetchUser(pat)
      account = { id: String(user.id), label: user.login }
    } catch (err) {
      console.error('[blowworks-auth] fetch /user échoué :', err.message)
    }
    cachedSession = {
      id: `blowworks-session-${account.id}`,
      accessToken: pat,
      account,
      // Scopes déclarés "larges" pour couvrir tout ce que Copilot / git /
      // pull-request-github peuvent demander. GitHub n'applique les scopes
      // qu'au niveau API ; déclarer plus large ici ne donne pas plus de
      // droits, ça évite juste les faux rejets `getSessions(scopes)`.
      scopes: ['repo', 'read:user', 'user:email', 'gist', 'workflow']
    }
    return cachedSession
  }

  const provider = {
    onDidChangeSessions: emitter.event,

    async getSessions(scopes) {
      const session = await buildSession()
      if (!session) return []
      if (Array.isArray(scopes) && scopes.length > 0) {
        // Acceptation "permissive" : si le PAT manque un scope demandé,
        // on retourne quand même la session. GitHub filtrera au niveau API
        // si besoin — c'est mieux que de forcer un Device Flow.
        const missing = scopes.filter((s) => !session.scopes.includes(s))
        if (missing.length > 0) {
          console.warn(
            '[blowworks-auth] scopes non déclarés, session retournée quand même :',
            missing.join(', ')
          )
        }
      }
      return [session]
    },

    async createSession(scopes) {
      const session = await buildSession()
      if (!session) {
        throw new Error(
          'BlowWorks : aucun PAT GitHub configuré. Ouvrez la sidebar BlowWorks → icône GitHub → collez votre token.'
        )
      }
      // Enregistre les scopes demandés si absents (informatif, ne change
      // pas les droits réels du token).
      let changed = false
      for (const s of scopes || []) {
        if (!session.scopes.includes(s)) {
          session.scopes.push(s)
          changed = true
        }
      }
      if (changed) emitter.fire({ added: [session], removed: [], changed: [] })
      else emitter.fire({ added: [session], removed: [], changed: [] })
      return session
    },

    async removeSession(sessionId) {
      if (cachedSession && cachedSession.id === sessionId) {
        const removed = cachedSession
        cachedSession = null
        emitter.fire({ added: [], removed: [removed], changed: [] })
      }
    }
  }

  providerDisposable = vscode.authentication.registerAuthenticationProvider(
    'github',
    'GitHub (BlowWorks)',
    provider,
    { supportsMultipleAccounts: false }
  )
  context.subscriptions.push(providerDisposable)

  // Surveille `pat.txt` : propage automatiquement les changements sans
  // redémarrer l'extension host. Utile quand BlowWorks réécrit le fichier
  // pendant que le sidecar tourne déjà.
  try {
    const watcher = fs.watch(path.dirname(patFile), (_eventType, filename) => {
      if (filename !== 'pat.txt') return
      const previous = cachedSession
      cachedSession = null
      buildSession().then((next) => {
        if (!previous && next) {
          emitter.fire({ added: [next], removed: [], changed: [] })
        } else if (previous && !next) {
          emitter.fire({ added: [], removed: [previous], changed: [] })
        } else if (previous && next && previous.accessToken !== next.accessToken) {
          emitter.fire({ added: [], removed: [], changed: [next] })
        }
      })
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  } catch (err) {
    console.error('[blowworks-auth] watch pat.txt impossible :', err)
  }
}

function deactivate() {
  // Remet le guard à null pour permettre une ré-activation propre si
  // VSCode recycle l'extension host.
  providerDisposable = null
}

module.exports = { activate, deactivate }
