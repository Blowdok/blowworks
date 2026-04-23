import { useEffect, useMemo, useState } from 'react'
import type { AgentT, AIModelT } from '@shared/ipc-contract.js'
import { useChatStore } from '../../stores/chat-store.js'
import ModelSelector from '../chat/ModelSelector.js'

// Onglet Settings > Agents (lot 3).
// Liste à gauche, éditeur à droite. Deux agents système au seed :
// 'synthesizer' et 'wiki_builder'. L'utilisateur peut éditer leur prompt,
// leur model, et leur état enabled. Il peut aussi créer des agents
// `custom` et les supprimer.

export default function AgentsSettingsTab(): React.ReactElement {
  const models = useChatStore((s) => s.models)
  const modelsLoading = useChatStore((s) => s.modelsLoading)
  const refreshModels = useChatStore((s) => s.refreshModels)

  const [agents, setAgents] = useState<AgentT[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [])

  async function refresh(): Promise<void> {
    try {
      const list = (await window.blow.agents.list()) as AgentT[]
      setAgents(list)
      setSelectedId((prev) => prev ?? list[0]?.id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId]
  )

  async function handleCreate(): Promise<void> {
    try {
      const created = (await window.blow.agents.create({
        name: 'Nouvel agent',
        description: '',
        model: models[0]?.id ?? 'anthropic/claude-sonnet-4-6',
        systemPrompt: 'Tu es un agent BlowWorks. Décris ton rôle ici.',
        temperature: 0.7,
        maxTokens: 4096,
        enabled: true
      })) as AgentT
      await refresh()
      setSelectedId(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      const res = (await window.blow.agents.delete(id)) as { ok: boolean; reason?: string }
      if (!res.ok) {
        setError(res.reason ?? 'Suppression refusée.')
        return
      }
      await refresh()
      setSelectedId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleSave(patch: Partial<AgentT> & { id: string }): Promise<void> {
    try {
      await window.blow.agents.update({
        id: patch.id,
        name: patch.name,
        description: patch.description,
        model: patch.model,
        systemPrompt: patch.systemPrompt,
        temperature: patch.temperature,
        maxTokens: patch.maxTokens,
        enabled: patch.enabled
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">Agents</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Unités d&apos;exécution one-shot qui traitent vos conversations et le Wiki.
          Deux agents système (<em>Synthétiseur</em>, <em>Wiki Builder</em>) sont fournis —
          vous pouvez éditer leur prompt et leur modèle, pas les supprimer. Créez des agents
          <em> custom</em> pour couvrir d&apos;autres besoins.
        </p>
      </header>

      {error && (
        <div className="text-[11px]" style={{ color: '#f87171' }}>
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Liste */}
        <aside
          className="flex w-60 shrink-0 flex-col rounded-[var(--radius-sm)] border"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center justify-between border-b px-2 py-1.5" style={{ borderColor: 'var(--border)' }}>
            <span className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
              {agents.length} agent{agents.length > 1 ? 's' : ''}
            </span>
            <button
              type="button"
              onClick={() => void handleCreate()}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[10px] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)]"
              title="Créer un agent custom"
            >
              + nouveau
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelectedId(a.id)}
                className="flex w-full flex-col items-start gap-0.5 border-b px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)]"
                style={{
                  borderColor: 'var(--border)',
                  background: a.id === selectedId ? 'var(--bg-tertiary)' : 'transparent'
                }}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: a.enabled ? 'var(--fg-secondary)' : 'var(--fg-muted)'
                    }}
                  />
                  <span
                    className="truncate text-[12px]"
                    style={{
                      color: a.id === selectedId ? 'var(--fg-primary)' : 'var(--fg-secondary)',
                      fontWeight: a.id === selectedId ? 600 : 400
                    }}
                  >
                    {a.name}
                  </span>
                </span>
                <span className="text-[9px] uppercase tracking-widest text-[var(--fg-muted)]">
                  {a.kind}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* Éditeur */}
        <div className="flex min-h-0 flex-1 flex-col">
          {selected ? (
            <AgentEditor
              key={selected.id}
              agent={selected}
              models={models}
              modelsLoading={modelsLoading}
              onRefreshModels={() => refreshModels(true)}
              onSave={(patch) => void handleSave({ ...patch, id: selected.id })}
              onDelete={selected.kind === 'custom' ? () => void handleDelete(selected.id) : null}
            />
          ) : (
            <div className="text-[12px] text-[var(--fg-muted)]">
              Sélectionnez un agent dans la liste.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────── Éditeur

interface AgentEditorProps {
  agent: AgentT
  models: AIModelT[]
  modelsLoading: boolean
  onRefreshModels: () => void
  onSave: (patch: Partial<AgentT>) => void
  onDelete: (() => void) | null
}

function AgentEditor({
  agent,
  models,
  modelsLoading,
  onRefreshModels,
  onSave,
  onDelete
}: AgentEditorProps): React.ReactElement {
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description)
  const [model, setModel] = useState(agent.model)
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt)
  const [temperature, setTemperature] = useState(agent.temperature)
  const [maxTokens, setMaxTokens] = useState(agent.maxTokens)
  const [enabled, setEnabled] = useState(agent.enabled)

  const isSystem = agent.kind !== 'custom'
  const dirty =
    name !== agent.name ||
    description !== agent.description ||
    model !== agent.model ||
    systemPrompt !== agent.systemPrompt ||
    temperature !== agent.temperature ||
    maxTokens !== agent.maxTokens ||
    enabled !== agent.enabled

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSystem}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[14px] font-semibold text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)] disabled:opacity-60"
          />
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
            {agent.kind}
          </span>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-[var(--fg-secondary)]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Activé
        </label>
      </div>

      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isSystem}
          rows={2}
          className="w-full resize-y rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 font-normal text-[12px] normal-case tracking-normal text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)] disabled:opacity-60"
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
          Modèle
        </span>
        <div className="flex items-center gap-2">
          <ModelSelector
            models={models}
            currentModelId={model}
            loading={modelsLoading}
            onSelect={setModel}
            onRefresh={onRefreshModels}
          />
          <code className="text-[10px] text-[var(--fg-muted)]">{model}</code>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
            Température
          </span>
          <code className="text-[10px] text-[var(--fg-muted)]">
            {temperature.toFixed(2)} — {temperatureLabel(temperature)}
          </code>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="flex-1 accent-[var(--fg-secondary)]"
          />
          <input
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isFinite(v)) setTemperature(Math.min(2, Math.max(0, v)))
            }}
            className="w-20 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
        </div>
        <span className="text-[10px] text-[var(--fg-muted)]">
          0 = déterministe (idéal pour JSON strict, synthèses factuelles) · 0.7 = équilibré · 1.5+ = créatif (brainstorm, variantes).
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
            Max tokens (sortie)
          </span>
          <code className="text-[10px] text-[var(--fg-muted)]">
            {maxTokens.toLocaleString('fr-FR')} tokens
          </code>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={128}
            max={32768}
            step={128}
            value={Math.min(32768, maxTokens)}
            onChange={(e) => setMaxTokens(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--fg-secondary)]"
          />
          <input
            type="number"
            min={128}
            max={200000}
            step={128}
            value={maxTokens}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) setMaxTokens(Math.min(200000, Math.max(128, v)))
            }}
            className="w-24 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
        </div>
        <span className="text-[10px] text-[var(--fg-muted)]">
          Plafonne la longueur de la réponse. 2 048 suffit pour une synthèse courte, 16 384+ pour un gros JSON de Wiki Builder. Au-delà de 32 768 tape la valeur à la main — dépend du modèle choisi.
        </span>
      </div>

      <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
        Prompt système
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={14}
          className="w-full flex-1 resize-y rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 font-normal text-[12px] normal-case tracking-normal text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
        />
      </label>

      <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px]"
              style={{ borderColor: '#ef4444', color: '#ef4444' }}
            >
              Supprimer
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onSave({ name, description, model, systemPrompt, temperature, maxTokens, enabled })}
          disabled={!dirty}
          className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: 'var(--fg-secondary)', color: 'var(--fg-secondary)' }}
        >
          Enregistrer
        </button>
      </div>
    </div>
  )
}

// Classement lisible de la température pour guider l'utilisateur. Seuils
// calés sur le mapping d'usage OpenAI/OpenRouter : <0.3 = tâches
// déterministes, 0.7 = conversationnel, >1.2 = créatif.
function temperatureLabel(t: number): string {
  if (t <= 0.2) return 'déterministe'
  if (t <= 0.5) return 'stable'
  if (t <= 0.9) return 'équilibré'
  if (t <= 1.3) return 'varié'
  return 'créatif'
}
