import { ipcMain, safeStorage } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, GitHubSetTokenInput } from '@shared/ipc-contract.js'
import { getDb } from '../services/db.js'
import { vscodeServer, writePatFile, getAuthExtensionDir } from '../services/vscode-server.js'
import { requestDeviceCode, waitForToken } from '../services/github-device-flow.js'

// Clés de settings (SQLite) où le PAT chiffré et le profil GitHub sont stockés.
const KEY_ENC = 'github.pat.encrypted'
const KEY_PROFILE = 'github.user.json'
// Stocke le dernier login connu même après "Se déconnecter" : sert de mémento
// pour le bouton "Reconnecter rapidement" quand le token est conservé.
const KEY_LAST_LOGIN = 'github.last.login'

interface StoredProfile {
  login: string
  avatarUrl: string | null
  scopes: string[]
}

interface StatusResponse {
  connected: boolean
  login: string | null
  avatarUrl: string | null
  scopes: string[]
  encryptionAvailable: boolean
  hasStoredToken: boolean
  lastLoginHint: string | null
}

function readProfile(): StoredProfile | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY_PROFILE) as
    | { value: string }
    | undefined
  if (!row?.value) return null
  try {
    return JSON.parse(row.value) as StoredProfile
  } catch {
    return null
  }
}

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

// Déchiffre le PAT stocké. Retourne null si absent, ou si safeStorage refuse
// (DB corrompue / clé OS changée).
function decryptStoredPat(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const enc = readSetting(KEY_ENC)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

// Valide un PAT contre api.github.com, retourne le profil (ou throw).
async function validatePat(pat: string): Promise<StoredProfile> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BlowWorks',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!res.ok) {
    throw new Error(`Token refusé par GitHub (HTTP ${res.status}).`)
  }
  const user = (await res.json()) as { login: string; avatar_url?: string | null }
  const scopesHeader = res.headers.get('x-oauth-scopes') ?? ''
  const scopes = scopesHeader
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return {
    login: user.login,
    avatarUrl: user.avatar_url ?? null,
    scopes
  }
}

function buildStatus(connected: boolean, profile: StoredProfile | null): StatusResponse {
  return {
    connected,
    login: profile?.login ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
    scopes: profile?.scopes ?? [],
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    hasStoredToken: readSetting(KEY_ENC) !== null,
    lastLoginHint: readSetting(KEY_LAST_LOGIN)
  }
}

// Applique le PAT : valide, met à jour profile, écrit pat.txt, redémarre
// sidecar. Retourne le status complet.
async function applyToken(pat: string): Promise<StatusResponse> {
  if (!safeStorage.isEncryptionAvailable()) {
    return buildStatus(false, null)
  }
  const profile = await validatePat(pat)

  const encrypted = safeStorage.encryptString(pat).toString('base64')
  writeSetting(KEY_ENC, encrypted)
  writeSetting(KEY_PROFILE, JSON.stringify(profile))
  writeSetting(KEY_LAST_LOGIN, profile.login)

  writePatFile(getAuthExtensionDir(), pat)
  await vscodeServer.restart()

  return buildStatus(true, profile)
}

const CompleteDeviceFlowInput = z.object({
  deviceCode: z.string().min(10),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive()
})

export function registerGitHubHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.github.getStatus, (): StatusResponse => {
    return buildStatus(readProfile() !== null, readProfile())
  })

  ipcMain.handle(IPC_CHANNELS.github.setToken, async (_evt, raw): Promise<StatusResponse> => {
    const { pat } = GitHubSetTokenInput.parse(raw)
    return applyToken(pat)
  })

  // "Reconnecter rapidement" : réutilise le PAT déjà chiffré dans les
  // settings. Utile quand l'utilisateur a fait une déconnexion soft et
  // veut revenir à la session sans recoller son token. Si le token stocké
  // est devenu invalide (expiré/révoqué), on throw — la UI affichera
  // alors le formulaire classique.
  ipcMain.handle(IPC_CHANNELS.github.reconnect, async (): Promise<StatusResponse> => {
    const pat = decryptStoredPat()
    if (!pat) {
      throw new Error(
        'Aucun token enregistré à réutiliser. Collez un nouveau PAT pour vous connecter.'
      )
    }
    return applyToken(pat)
  })

  // Déconnexion "soft" : efface le profil courant et `pat.txt` (VSCode voit
  // l'user comme déconnecté), MAIS garde le PAT chiffré dans les settings
  // pour permettre un "reconnect" rapide sans avoir à recoller le token.
  // `hasStoredToken` reste `true` dans le status → la UI peut afficher
  // un bouton "Reconnecter (@<lastLoginHint>)".
  ipcMain.handle(IPC_CHANNELS.github.disconnect, async (): Promise<StatusResponse> => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(KEY_PROFILE)
    writePatFile(getAuthExtensionDir(), null)
    await vscodeServer.restart()
    return buildStatus(false, null)
  })

  // "Oublier ce token" : hard reset, efface tout y compris le PAT chiffré
  // et le dernier login. Pour quand l'utilisateur veut vraiment tout purger
  // (ex. changement de compte, token compromis).
  ipcMain.handle(IPC_CHANNELS.github.forgetToken, async (): Promise<StatusResponse> => {
    getDb()
      .prepare('DELETE FROM settings WHERE key IN (?, ?, ?)')
      .run(KEY_ENC, KEY_PROFILE, KEY_LAST_LOGIN)
    writePatFile(getAuthExtensionDir(), null)
    await vscodeServer.restart()
    return buildStatus(false, null)
  })

  // Démarre le Device Flow OAuth : retourne immédiatement le user_code +
  // verification_uri à afficher dans la UI, plus le device_code à passer
  // ensuite à `completeDeviceFlow` pour démarrer le polling. Ce token est
  // requis pour que Copilot fonctionne — un PAT classique est rejeté par
  // son endpoint d'auth interne.
  ipcMain.handle(IPC_CHANNELS.github.startDeviceFlow, async () => {
    const init = await requestDeviceCode()
    return {
      userCode: init.user_code,
      verificationUri: init.verification_uri,
      deviceCode: init.device_code,
      interval: init.interval,
      expiresIn: init.expires_in
    }
  })

  // Polling bloquant jusqu'à obtention du token OAuth. Le polling est géré
  // côté main pour éviter au renderer d'orchestrer. La promise résout quand
  // l'utilisateur a autorisé l'appli sur github.com/login/device, ou throw
  // si expiration/refus/annulation. En succès, le token est traité comme
  // un PAT (stocké chiffré, écrit dans pat.txt, sidecar redémarré).
  ipcMain.handle(
    IPC_CHANNELS.github.completeDeviceFlow,
    async (_evt, raw): Promise<StatusResponse> => {
      const { deviceCode, expiresIn, interval } = CompleteDeviceFlowInput.parse(raw)
      const accessToken = await waitForToken({
        device_code: deviceCode,
        user_code: '',
        verification_uri: '',
        interval,
        expires_in: expiresIn
      })
      // `applyToken` valide contre /user, chiffre, persiste, écrit pat.txt,
      // restart sidecar — exactement ce qu'on veut pour le token OAuth aussi
      // (format de token compatible côté API GitHub).
      return applyToken(accessToken)
    }
  )
}
