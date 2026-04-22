// GitHub OAuth Device Flow pour obtenir un token utilisable par Copilot.
// Les PAT classiques/fine-grained sont REJETÉS par l'endpoint
// `api.github.com/copilot_internal/v2/token`. Seuls les tokens OAuth
// obtenus avec un `client_id` spécifique sont acceptés — on utilise le
// client_id extrait de l'extension `vscode.github-authentication` native.
//
// Le flow Device Code :
//   1. POST /login/device/code → retourne user_code + verification_uri
//   2. User saisit user_code sur github.com/login/device (autre fenêtre)
//   3. POST /login/oauth/access_token en polling → access_token quand OK
//
// Référence : https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

// Client id public de l'extension `vscode.github-authentication` — trouvé
// dans son `extension.js` minifié via grep. Les tokens obtenus avec ce
// client_id sont reconnus par l'endpoint Copilot interne.
export const GITHUB_AUTH_CLIENT_ID = '01ab8ac9400c4e429b23'

export interface DeviceCodeInit {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

export async function requestDeviceCode(): Promise<DeviceCodeInit> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BlowWorks-Auth'
    },
    body: JSON.stringify({
      client_id: GITHUB_AUTH_CLIENT_ID,
      // `read:user` suffit pour Copilot : GitHub vérifie la subscription
      // du COMPTE identifié par le token, pas les scopes du token lui-même.
      // On ajoute `repo` pour que le même token serve aux opérations git.
      scope: 'read:user repo user:email workflow'
    })
  })
  if (!res.ok) {
    throw new Error(`Device code request refusé par GitHub (HTTP ${res.status}).`)
  }
  const data = (await res.json()) as Partial<DeviceCodeInit> & { error?: string }
  if (data.error || !data.device_code) {
    throw new Error(`Device code invalide : ${data.error ?? 'réponse vide'}.`)
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code!,
    verification_uri: data.verification_uri!,
    interval: data.interval ?? 5,
    expires_in: data.expires_in ?? 900
  }
}

export interface PollResult {
  status: 'success' | 'pending' | 'error'
  accessToken?: string
  error?: string
  newInterval?: number
}

// Une itération de polling — à rappeler à `interval` secondes jusqu'à
// obtenir `success` ou `error` (autre que pending/slow_down).
export async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BlowWorks-Auth'
    },
    body: JSON.stringify({
      client_id: GITHUB_AUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  })
  if (!res.ok) {
    return { status: 'error', error: `HTTP ${res.status}` }
  }
  const data = (await res.json()) as {
    access_token?: string
    error?: string
    error_description?: string
    interval?: number
  }
  if (data.access_token) {
    return { status: 'success', accessToken: data.access_token }
  }
  if (data.error === 'authorization_pending') {
    return { status: 'pending' }
  }
  if (data.error === 'slow_down') {
    return { status: 'pending', newInterval: data.interval }
  }
  return {
    status: 'error',
    error: data.error_description ?? data.error ?? 'Erreur OAuth inconnue.'
  }
}

// Helper : polling complet jusqu'à succès, erreur ou expiration du code.
// Appelé côté main si on veut un handler IPC single-shot (simple pour la UI).
export async function waitForToken(init: DeviceCodeInit): Promise<string> {
  const deadline = Date.now() + init.expires_in * 1000
  let interval = init.interval
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000))
    const res = await pollDeviceToken(init.device_code)
    if (res.status === 'success' && res.accessToken) return res.accessToken
    if (res.status === 'error') throw new Error(res.error ?? 'Device flow échec.')
    if (res.newInterval) interval = res.newInterval
  }
  throw new Error('Device code expiré (pas d’autorisation à temps).')
}
