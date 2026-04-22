import { useEffect, useState } from 'react'

// Widget d'authentification GitHub persistante via PAT.
// Le token est validé contre api.github.com/user, chiffré côté main via
// safeStorage (DPAPI sur Windows), puis injecté comme env `GITHUB_TOKEN`
// dans le spawn du sidecar VSCode. Toutes les shapes VSCode partagent donc
// la même session GitHub sans re-auth à chaque iframe.

interface Status {
  connected: boolean
  login: string | null
  avatarUrl: string | null
  scopes: string[]
  encryptionAvailable: boolean
  hasStoredToken: boolean
  lastLoginHint: string | null
}

const SCOPES_URL =
  'https://github.com/settings/tokens/new?scopes=repo,read:user,gist,workflow&description=BlowWorks'

export default function GitHubAccount({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    void window.blow.github.getStatus().then((s: Status) => setStatus(s))
  }, [])

  async function refresh(): Promise<void> {
    const s = await window.blow.github.getStatus()
    setStatus(s)
  }

  const title = status?.connected
    ? `Connecté à GitHub : @${status.login}`
    : 'Connecter GitHub pour éviter les ré-auths VSCode'

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className={
          compact
            ? 'flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] transition-colors hover:border-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]'
            : 'flex w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)]'
        }
        title={title}
        aria-label={title}
      >
        {status?.connected && status.avatarUrl ? (
          <img
            src={status.avatarUrl}
            alt=""
            className={compact ? 'h-6 w-6 rounded-full' : 'h-5 w-5 rounded-full'}
            referrerPolicy="no-referrer"
          />
        ) : (
          <GitHubIcon />
        )}
        {!compact && (
          <span
            className="truncate"
            style={{ color: status?.connected ? 'var(--fg-secondary)' : 'var(--fg-muted)' }}
          >
            {status?.connected ? `@${status.login}` : 'Connecter GitHub'}
          </span>
        )}
      </button>

      {dialogOpen && (
        <Dialog
          status={status}
          onClose={() => setDialogOpen(false)}
          onChanged={(s) => {
            setStatus(s)
            if (s.connected) setDialogOpen(false)
          }}
          onRefresh={refresh}
        />
      )}
    </>
  )
}

function Dialog({
  status,
  onClose,
  onChanged,
  onRefresh
}: {
  status: Status | null
  onClose: () => void
  onChanged: (s: Status) => void
  onRefresh: () => Promise<void>
}) {
  const [pat, setPat] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect(): Promise<void> {
    if (!pat.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = (await window.blow.github.setToken(pat.trim())) as Status
      if (!res.encryptionAvailable) {
        setError(
          'Chiffrement local indisponible sur cette machine. Le token n’a pas été sauvegardé.'
        )
        return
      }
      onChanged(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de validation du token.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDisconnect(): Promise<void> {
    setSubmitting(true)
    try {
      const res = (await window.blow.github.disconnect()) as Status
      onChanged(res)
      await onRefresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleReconnect(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      const res = (await window.blow.github.reconnect()) as Status
      onChanged(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reconnexion impossible.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleForgetToken(): Promise<void> {
    setSubmitting(true)
    try {
      const res = (await window.blow.github.forgetToken()) as Status
      onChanged(res)
      await onRefresh()
    } finally {
      setSubmitting(false)
    }
  }

  // État du Device Flow OAuth en cours. Quand `init` est set, on affiche un
  // écran overlay avec le user_code. Le polling est côté main (bloquant via
  // completeDeviceFlow) — on n'a rien à orchestrer ici.
  const [deviceInit, setDeviceInit] = useState<{
    userCode: string
    verificationUri: string
    deviceCode: string
    interval: number
    expiresIn: number
  } | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)

  async function handleConnectCopilot(): Promise<void> {
    setDeviceError(null)
    setSubmitting(true)
    try {
      const init = (await window.blow.github.startDeviceFlow()) as {
        userCode: string
        verificationUri: string
        deviceCode: string
        interval: number
        expiresIn: number
      }
      setDeviceInit(init)
      // Copie automatique du code + ouverture du navigateur externe.
      try {
        await navigator.clipboard.writeText(init.userCode)
      } catch {
        /* clipboard peut échouer en contexte sandbox — non bloquant */
      }
      window.open(init.verificationUri, '_blank', 'noopener,noreferrer')

      // Polling bloquant côté main (retourne quand l'user a autorisé ou
      // quand le code expire). On ne reactive le loader qu'après.
      const res = (await window.blow.github.completeDeviceFlow({
        deviceCode: init.deviceCode,
        expiresIn: init.expiresIn,
        interval: init.interval
      })) as Status
      setDeviceInit(null)
      onChanged(res)
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : 'Échec de la connexion OAuth Copilot.'
      )
      setDeviceInit(null)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 text-[var(--fg-primary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Authentification GitHub</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>

        {status?.connected ? (
          <div className="space-y-3 text-xs">
            <div className="flex items-center gap-2.5">
              {status.avatarUrl && (
                <img
                  src={status.avatarUrl}
                  alt=""
                  className="h-8 w-8 rounded-full"
                  referrerPolicy="no-referrer"
                />
              )}
              <div>
                <div className="font-medium text-[var(--fg-primary)]">@{status.login}</div>
                <div className="text-[var(--fg-muted)]">
                  {status.scopes.length > 0
                    ? `Scopes : ${status.scopes.join(', ')}`
                    : 'Aucun scope détecté.'}
                </div>
              </div>
            </div>
            <p className="text-[var(--fg-muted)]">
              Ce token est injecté automatiquement dans chaque instance VSCode du canvas. Plus
              besoin de vous reconnecter à chaque shape.
            </p>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDisconnect()}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--fg-muted)] transition-colors hover:border-red-600/60 hover:text-red-400 disabled:opacity-50"
            >
              {submitting ? 'Déconnexion…' : 'Se déconnecter'}
            </button>
          </div>
        ) : deviceInit ? (
          <div className="space-y-3 text-xs">
            <p className="text-[var(--fg-muted)]">
              Une page GitHub s&apos;est ouverte dans votre navigateur. Collez-y le
              code ci-dessous, puis autorisez l&apos;application. Le code a été copié
              dans votre presse-papiers.
            </p>
            <div
              className="rounded-[var(--radius-md)] border border-[var(--fg-secondary)] bg-[var(--bg-primary)] py-6 text-center"
              style={{ color: 'var(--fg-secondary)' }}
            >
              <div className="font-mono text-2xl font-bold tracking-[0.4em]">
                {deviceInit.userCode}
              </div>
            </div>
            <div className="flex flex-col gap-1 text-[var(--fg-muted)]">
              <span>
                URL :{' '}
                <a
                  href={deviceInit.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--fg-secondary)] hover:underline"
                >
                  {deviceInit.verificationUri}
                </a>
              </span>
              <span>
                Expire dans {Math.floor(deviceInit.expiresIn / 60)} min. En
                attente d&apos;autorisation…
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  window.open(
                    deviceInit.verificationUri,
                    '_blank',
                    'noopener,noreferrer'
                  )
                  void navigator.clipboard.writeText(deviceInit.userCode).catch(() => {})
                }}
                className="flex-1 rounded-[var(--radius-sm)] border border-[var(--fg-secondary)] bg-[var(--fg-secondary)]/10 py-1.5 font-medium text-[var(--fg-secondary)] hover:bg-[var(--fg-secondary)]/20"
              >
                Rouvrir la page + copier le code
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            {/* Option préférée : Device Flow OAuth, compatible Copilot. */}
            <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--fg-secondary)]/60 bg-[var(--fg-secondary)]/10 p-3">
              <div className="font-semibold text-[var(--fg-primary)]">
                Connexion rapide (Copilot compatible)
              </div>
              <p className="text-[var(--fg-muted)]">
                Authentifiez-vous via GitHub.com en deux clics. Le token obtenu
                fonctionne aussi pour Copilot et git, contrairement aux PAT
                classiques.
              </p>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleConnectCopilot()}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--fg-secondary)] bg-[var(--fg-secondary)] py-1.5 font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {submitting ? 'Connexion…' : 'Se connecter avec GitHub'}
              </button>
              {deviceError && (
                <div className="rounded-[var(--radius-sm)] border border-red-600/40 bg-red-900/20 px-2 py-1 text-red-300">
                  {deviceError}
                </div>
              )}
            </div>

            {status?.hasStoredToken && (
              <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--fg-secondary)]/40 bg-[var(--fg-secondary)]/5 p-3">
                <div className="font-medium text-[var(--fg-primary)]">
                  Token précédent enregistré
                  {status.lastLoginHint && (
                    <span className="text-[var(--fg-muted)]"> (@{status.lastLoginHint})</span>
                  )}
                </div>
                <p className="text-[var(--fg-muted)]">
                  Reconnectez-vous sans recoller votre token. Le PAT chiffré est
                  réutilisé tel quel.
                </p>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleReconnect()}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--fg-secondary)] bg-[var(--fg-secondary)]/10 py-1.5 font-medium text-[var(--fg-secondary)] transition-colors hover:bg-[var(--fg-secondary)]/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? 'Reconnexion…' : 'Reconnexion rapide'}
                </button>
              </div>
            )}

            <p className="text-[var(--fg-muted)]">
              {status?.hasStoredToken
                ? 'Ou collez un autre token pour changer de compte :'
                : 'Générez un Personal Access Token GitHub pour éviter la ré-authentification à chaque nouvelle shape VSCode. Le token sera chiffré localement.'}
            </p>
            <a
              href={SCOPES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded-[var(--radius-sm)] border border-[var(--fg-secondary)] px-2.5 py-1 text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              → Générer un PAT (scopes pré-remplis)
            </a>

            <label className="block">
              <span className="mb-1 block font-medium text-[var(--fg-primary)]">
                Collez votre token ici
              </span>
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="ghp_… ou github_pat_…"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-xs text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !submitting) void handleConnect()
                }}
              />
            </label>

            {error && (
              <div className="rounded-[var(--radius-sm)] border border-red-600/40 bg-red-900/20 px-2 py-1.5 text-red-300">
                {error}
              </div>
            )}

            {status && !status.encryptionAvailable && (
              <div className="rounded-[var(--radius-sm)] border border-yellow-600/40 bg-yellow-900/20 px-2 py-1.5 text-yellow-300">
                Chiffrement local indisponible sur cette machine. La connexion sera refusée
                tant que safeStorage n’est pas accessible (DPAPI Windows).
              </div>
            )}

            <button
              type="button"
              disabled={submitting || !pat.trim()}
              onClick={() => void handleConnect()}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--fg-secondary)] bg-[var(--fg-secondary)]/10 py-1.5 font-medium text-[var(--fg-secondary)] transition-colors hover:bg-[var(--fg-secondary)]/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Validation…' : 'Connecter'}
            </button>

            {status?.hasStoredToken && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleForgetToken()}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] py-1.5 text-[var(--fg-muted)] transition-colors hover:border-red-600/60 hover:text-red-400 disabled:opacity-50"
              >
                Oublier le token enregistré
              </button>
            )}

            <p className="text-[var(--fg-muted)]">
              Après connexion, toutes les shapes VSCode ouvertes seront rechargées pour prendre
              en compte le nouveau token.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function GitHubIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.1-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.08 1.84 2.83 1.31 3.52 1 .11-.78.42-1.31.77-1.61-2.67-.3-5.48-1.33-5.48-5.94 0-1.31.47-2.38 1.24-3.22-.12-.31-.54-1.53.12-3.18 0 0 1-.32 3.3 1.23a11.47 11.47 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.65.24 2.87.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.62-2.81 5.63-5.49 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.22.71.83.58A12 12 0 0 0 12 .3" />
    </svg>
  )
}
