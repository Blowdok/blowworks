import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../stores/chat-store.js'
import ModelSelector from './chat/ModelSelector.js'
import WikiSettingsTab from './settings/WikiSettingsTab.js'
import AgentsSettingsTab from './settings/AgentsSettingsTab.js'
import BrowserSettingsTab from './settings/BrowserSettingsTab.js'

// Modale Paramètres plein écran : sidebar verticale à gauche + panneau
// de réglages à droite. Rendue via `createPortal(document.body)` — même
// pattern que `ConfirmDialog.tsx` pour échapper aux clip containers
// portails et garantir un z-index global correct.
//
// Onglets Lot 1 :
//   - IA · OpenRouter (clé API + modèle par défaut + température)
//   - IA · Recherche web Tavily (clé API)
//   - Placeholders grisés : Agents, MCP, Presets (lots 3/4)

type Tab = 'openrouter' | 'tavily' | 'defaults' | 'wiki' | 'agents' | 'browser'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  initialTab?: Tab
}

export default function SettingsModal({
  open,
  onClose,
  initialTab
}: SettingsModalProps): React.ReactElement | null {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'openrouter')

  // Si `initialTab` change pendant que la modale est ouverte (ex: user
  // clique "Configurer le wiki" depuis la sidebar alors que Settings était
  // déjà ouvert sur OpenRouter), on switche sur le tab demandé sans avoir
  // à fermer/rouvrir. Pattern render-reset pour éviter setState-in-effect.
  const [lastInitialTab, setLastInitialTab] = useState(initialTab)
  if (initialTab !== lastInitialTab) {
    setLastInitialTab(initialTab)
    if (initialTab) setTab(initialTab)
  }

  // Échap = fermer. Ctrl+W aussi (reflexe app-desktop).
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-stretch"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      {/* Plein écran : pas de backdrop, pas de margin. La modale occupe
          tout le viewport pour que les dropdowns internes (ModelSelector,
          history) aient toute la place nécessaire. Ferme via la croix ou
          Échap — le clic-dehors-pour-fermer n'a plus lieu d'être.
          `onPointerDown stop` : empêche que les listeners globaux de tldraw
          (canvas en dessous) captent des pointer events qui pourraient
          interférer avec les handlers React de la modale. */}
      <div
        className="flex h-full w-full overflow-hidden text-[var(--fg-primary)]"
        style={{ background: 'var(--bg-secondary)' }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar onglets */}
        <aside
          className="flex w-56 shrink-0 flex-col border-r"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}
        >
          <div className="flex items-center gap-2 border-b px-3 py-3" style={{ borderColor: 'var(--border)' }}>
            {/* Bouton retour (remplace l'ancienne croix × qui ne réagissait
                plus à cause des listeners globaux de tldraw). Placé en
                TÊTE de rangée + stopPropagation explicite pour garantir
                qu'il capte toujours le clic avant tout handler ancêtre. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              title="Retour (Échap)"
              aria-label="Retour"
            >
              <span aria-hidden>←</span>
              <span>Retour</span>
            </button>
            <h2
              id="settings-modal-title"
              className="flex-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]"
            >
              Paramètres
            </h2>
          </div>
          <div className="flex flex-col gap-0.5 p-2">
            <TabButton active={tab === 'openrouter'} onClick={() => setTab('openrouter')}>
              OpenRouter
            </TabButton>
            <TabButton active={tab === 'tavily'} onClick={() => setTab('tavily')}>
              Recherche web
            </TabButton>
            <TabButton active={tab === 'defaults'} onClick={() => setTab('defaults')}>
              Modèle par défaut
            </TabButton>
            <TabButton active={tab === 'wiki'} onClick={() => setTab('wiki')}>
              Wiki
            </TabButton>
            <TabButton active={tab === 'agents'} onClick={() => setTab('agents')}>
              Agents
            </TabButton>
            <TabButton active={tab === 'browser'} onClick={() => setTab('browser')}>
              Navigateur
            </TabButton>
            <div className="mt-3 border-t px-2 pt-3 text-[10px] uppercase tracking-widest text-[var(--fg-muted)]" style={{ borderColor: 'var(--border)' }}>
              À venir
            </div>
            <TabButton active={false} onClick={() => {}} disabled>
              Presets
            </TabButton>
            <TabButton active={false} onClick={() => {}} disabled>
              MCP
            </TabButton>
          </div>
        </aside>

        {/* Panneau de contenu */}
        <section className="flex flex-1 flex-col overflow-y-auto p-6">
          {tab === 'openrouter' && <OpenRouterTab />}
          {tab === 'tavily' && <TavilyTab />}
          {/* `key` basé sur les défauts du store : chaque changement externe
              remonte le DefaultsTab avec un état local frais, sans avoir
              besoin d'un useEffect + setState (bloqué par le lint). */}
          {tab === 'defaults' && <DefaultsTab />}
          {tab === 'wiki' && <WikiSettingsTab />}
          {tab === 'agents' && <AgentsSettingsTab />}
          {tab === 'browser' && <BrowserSettingsTab />}
        </section>
      </div>
    </div>,
    document.body
  )
}

function TabButton({
  active,
  onClick,
  disabled,
  children
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: active ? 'var(--bg-tertiary)' : 'transparent',
        color: active ? 'var(--fg-secondary)' : 'var(--fg-primary)',
        fontWeight: active ? 600 : 400
      }}
    >
      {children}
    </button>
  )
}

// ──────────────────────────────────────────────────────────── OpenRouter

function OpenRouterTab(): React.ReactElement {
  const apiKeyStatus = useChatStore((s) => s.apiKeyStatus)
  const refreshApiKeyStatus = useChatStore((s) => s.refreshApiKeyStatus)
  const refreshModels = useChatStore((s) => s.refreshModels)

  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function saveKey(): Promise<void> {
    if (draft.trim().length < 10) return
    setStatus('saving')
    setError(null)
    try {
      await window.blow.ai.setApiKey({ provider: 'openrouter', key: draft.trim() })
      setDraft('')
      await refreshApiKeyStatus()
      void refreshModels(true)
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus('error')
      setError(msg)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">OpenRouter</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Clé API utilisée pour tous les appels de modèles. Stockée chiffrée via{' '}
          <code>safeStorage</code> sur votre machine — jamais transmise au renderer.
          Obtenez une clé sur{' '}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--fg-secondary)] underline"
          >
            openrouter.ai/keys
          </a>
          .
        </p>
      </header>

      <div
        className="rounded-[var(--radius-sm)] border px-3 py-2 text-[12px]"
        style={{
          borderColor: apiKeyStatus.openrouter ? 'var(--fg-secondary)' : 'var(--border)',
          color: apiKeyStatus.openrouter ? 'var(--fg-secondary)' : 'var(--fg-muted)'
        }}
      >
        {apiKeyStatus.openrouter ? '✓ Clé configurée et active.' : '✗ Aucune clé enregistrée.'}
        {!apiKeyStatus.encryptionAvailable && (
          <div className="mt-1 text-[11px]" style={{ color: '#f87171' }}>
            ⚠ Le chiffrement système n&apos;est pas disponible sur cette machine.
            L&apos;enregistrement sera refusé pour des raisons de sécurité.
          </div>
        )}
      </div>

      <label className="flex flex-col gap-1 text-[12px] text-[var(--fg-secondary)]">
        <span>Nouvelle clé API (commence par <code>sk-or-</code>)</span>
        <div className="flex gap-2">
          <input
            type={reveal ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-or-v1-…"
            className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-[13px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 text-[11px] hover:bg-[var(--bg-tertiary)]"
            title={reveal ? 'Masquer' : 'Afficher'}
          >
            {reveal ? '🙈' : '👁'}
          </button>
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={draft.trim().length < 10 || status === 'saving' || !apiKeyStatus.encryptionAvailable}
            className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          >
            {status === 'saving' ? '…' : 'Enregistrer'}
          </button>
        </div>
      </label>

      {status === 'saved' && (
        <div className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>
          ✓ Clé enregistrée — liste des modèles rafraîchie.
        </div>
      )}
      {status === 'error' && error && (
        <div className="text-[11px]" style={{ color: '#f87171' }}>
          {error}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Tavily

function TavilyTab(): React.ReactElement {
  const apiKeyStatus = useChatStore((s) => s.apiKeyStatus)
  const refreshApiKeyStatus = useChatStore((s) => s.refreshApiKeyStatus)

  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function saveKey(): Promise<void> {
    if (draft.trim().length < 10) return
    setStatus('saving')
    setError(null)
    try {
      await window.blow.ai.setApiKey({ provider: 'tavily', key: draft.trim() })
      setDraft('')
      await refreshApiKeyStatus()
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus('error')
      setError(msg)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">
          Recherche web · Tavily
        </h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Active le bouton 🌐 dans les conversations : avant l&apos;envoi au modèle,
          BlowWorks appelle Tavily pour récupérer un contexte web à jour et le
          transmet au LLM. Obtenez une clé sur{' '}
          <a
            href="https://tavily.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--fg-secondary)] underline"
          >
            tavily.com
          </a>{' '}
          (1000 requêtes gratuites / mois).
        </p>
      </header>

      <div
        className="rounded-[var(--radius-sm)] border px-3 py-2 text-[12px]"
        style={{
          borderColor: apiKeyStatus.tavily ? 'var(--fg-secondary)' : 'var(--border)',
          color: apiKeyStatus.tavily ? 'var(--fg-secondary)' : 'var(--fg-muted)'
        }}
      >
        {apiKeyStatus.tavily
          ? '✓ Clé Tavily configurée — la recherche web est disponible.'
          : '✗ Aucune clé Tavily. Le bouton 🌐 n\'aura pas d\'effet.'}
      </div>

      <label className="flex flex-col gap-1 text-[12px] text-[var(--fg-secondary)]">
        <span>Clé API Tavily (commence par <code>tvly-</code>)</span>
        <div className="flex gap-2">
          <input
            type={reveal ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="tvly-…"
            className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-[13px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 text-[11px] hover:bg-[var(--bg-tertiary)]"
            title={reveal ? 'Masquer' : 'Afficher'}
          >
            {reveal ? '🙈' : '👁'}
          </button>
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={draft.trim().length < 10 || status === 'saving' || !apiKeyStatus.encryptionAvailable}
            className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
          >
            {status === 'saving' ? '…' : 'Enregistrer'}
          </button>
        </div>
      </label>

      {status === 'saved' && (
        <div className="text-[11px]" style={{ color: 'var(--fg-secondary)' }}>
          ✓ Clé Tavily enregistrée.
        </div>
      )}
      {status === 'error' && error && (
        <div className="text-[11px]" style={{ color: '#f87171' }}>
          {error}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Défauts

function DefaultsTab(): React.ReactElement {
  const defaults = useChatStore((s) => s.defaults)
  const refreshDefaults = useChatStore((s) => s.refreshDefaults)
  const models = useChatStore((s) => s.models)
  const modelsLoading = useChatStore((s) => s.modelsLoading)
  const refreshModels = useChatStore((s) => s.refreshModels)

  // État local initialisé UNE FOIS depuis le store. Les changements externes
  // (saves concurrents, qui sont rarissimes) ne propagent pas tant que
  // l'utilisateur n'a pas fermé/rouvert l'onglet — acceptable en UX et
  // évite le pattern setState-in-effect (anti-pattern React 19).
  const [model, setModel] = useState(() => defaults.model)
  const [temperature, setTemperature] = useState(() => defaults.temperature)
  const [maxTokens, setMaxTokens] = useState(() => defaults.maxTokens)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  async function save(): Promise<void> {
    setStatus('saving')
    await window.blow.ai.setDefaults({ model, temperature, maxTokens })
    await refreshDefaults()
    setStatus('saved')
    setTimeout(() => setStatus('idle'), 2000)
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">Modèle par défaut</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Préréglages utilisés à la création d&apos;une nouvelle ChatShape. Chaque conversation
          peut ensuite changer son propre modèle via le sélecteur dans son en-tête.
        </p>
      </header>

      <div className="flex flex-col gap-1 text-[12px] text-[var(--fg-secondary)]">
        <span>Modèle</span>
        {/* Même sélecteur que dans l'en-tête de chaque ChatShape : recherche
            par mot-clé (id + nom), carte avec prix input/output par 1M tokens
            et fenêtre de contexte. Code réutilisé — pas de divergence UX. */}
        <ModelSelector
          models={models}
          currentModelId={model}
          loading={modelsLoading}
          onSelect={setModel}
          onRefresh={() => void refreshModels(true)}
        />
      </div>

      <label className="flex flex-col gap-1 text-[12px] text-[var(--fg-secondary)]">
        <span>
          Température · <span className="font-mono text-[var(--fg-primary)]">{temperature.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
        />
      </label>

      <label className="flex flex-col gap-1 text-[12px] text-[var(--fg-secondary)]">
        <span>Max tokens (sortie)</span>
        <input
          type="number"
          min={256}
          max={32000}
          step={256}
          value={maxTokens}
          onChange={(e) => setMaxTokens(Number(e.target.value))}
          className="w-32 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[13px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
        />
      </label>

      <div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving'}
          className="rounded-[var(--radius-sm)] border px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
        >
          {status === 'saving' ? '…' : 'Enregistrer'}
        </button>
        {status === 'saved' && (
          <span className="ml-2 text-[11px]" style={{ color: 'var(--fg-secondary)' }}>
            ✓ Enregistré
          </span>
        )}
      </div>
    </div>
  )
}
