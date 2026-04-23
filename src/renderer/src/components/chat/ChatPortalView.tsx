import { useMemo, useRef, useState, useEffect } from 'react'
import { useEditor } from 'tldraw'
import { nanoid } from 'nanoid'
import type { ChatShape } from '../canvas/shapes/ChatShape.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useProjectStore } from '../../stores/project-store.js'
import { useWikiStore } from '../../stores/wiki-store.js'
import ChatMessageList from './ChatMessageList.js'
import ChatInput from './ChatInput.js'
import ModelSelector from './ModelSelector.js'
import ConversationHistoryDropdown from './ConversationHistoryDropdown.js'
import {
  useShapeBorderState,
  getShapeBorderStyle
} from '../../lib/use-shape-border-state.js'

// Vue complète du portail d'une ChatShape :
//   ┌ header : titre + modèle + projet + ⏱ historique + « + new »
//   ├ historique scrollable (ChatMessageList + streaming bubble)
//   └ zone de saisie (ChatInput)
//
// Le composant est monté dans le portail HORS tldraw (cf. ShapePortalManager)
// et hérite de `pointer-events: none` sur le conteneur root — on réactive
// explicitement sur chaque élément interactif (pattern TerminalShape).
//
// Découplage shape ⇄ conversation :
// La conversation active est `shape.props.conversationId`. Le bouton « + new »
// crée une NOUVELLE conversation et la plugge sur la MÊME shape (pas de shape
// dupliquée). Le bouton ⏱ ouvre la liste de toutes les conversations DB pour
// permettre de switcher. Si `conversationId` est `null` (ancienne shape
// restaurée d'un snapshot antérieur au découplage), on tombe sur `shape.id`
// en rétrocompat — les deux valeurs coïncidaient pour les premières shapes.

interface ChatPortalViewProps {
  shape: ChatShape
}

export default function ChatPortalView({ shape }: ChatPortalViewProps): React.ReactElement {
  const editor = useEditor()
  const projects = useProjectStore((s) => s.projects)

  // Résout l'id de conversation actif. Si les props ne le portent pas encore
  // (shape héritée d'avant le découplage), on retombe sur shape.id comme
  // avant — les anciens couples (shape, conv) avaient exactement ce id.
  const convId = useMemo(
    () => shape.props.conversationId ?? shape.id,
    [shape.props.conversationId, shape.id]
  )

  const conversation = useChatStore((s) => s.conversations.get(convId))
  const activeStream = useChatStore((s) => s.activeStreams.get(convId))
  const allConversations = useChatStore((s) => s.allConversations)
  const models = useChatStore((s) => s.models)
  const modelsLoading = useChatStore((s) => s.modelsLoading)
  const apiKeyStatus = useChatStore((s) => s.apiKeyStatus)
  const defaults = useChatStore((s) => s.defaults)

  const sendMessage = useChatStore((s) => s.sendMessage)
  const cancelStream = useChatStore((s) => s.cancelStream)
  const ensureConversation = useChatStore((s) => s.ensureConversation)
  const loadConversation = useChatStore((s) => s.loadConversation)
  const updateStoreConversation = useChatStore((s) => s.updateConversation)
  const refreshAllConversations = useChatStore((s) => s.refreshAllConversations)
  const deleteConversationById = useChatStore((s) => s.deleteConversationById)
  const refreshModels = useChatStore((s) => s.refreshModels)

  const [draft, setDraft] = useState('')
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  const [historyDropdownOpen, setHistoryDropdownOpen] = useState(false)
  const [synthState, setSynthState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'success'; filename: string }
    | { kind: 'flush-ok' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  // Statut wiki réactif : toute mutation (chooseFolder, reconstruire,
  // synthétiser) refresh le store → tous les consommateurs rerender.
  // Plus de state local chargé une fois au mount qui reste figé si
  // l'utilisateur configure le wiki après avoir ouvert la ChatShape.
  const wikiStatus = useWikiStore((s) => s.status)
  const refreshWikiStatus = useWikiStore((s) => s.refresh)
  const wikiConfigured = wikiStatus.initialized

  const assignedProject = projects.find((p) => p.id === shape.props.projectId) ?? null
  const hasKey = apiKeyStatus.openrouter
  const isStreaming = activeStream !== undefined

  // Hydratation paresseuse : un flag par convId dans un ref (Map) — pour que
  // switcher la shape vers une conversation déjà vue ne retente pas un
  // create, mais load aussi la nouvelle quand on vient d'y switcher.
  const hydratedMapRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (hydratedMapRef.current.has(convId)) return
    hydratedMapRef.current.add(convId)
    void ensureConversation(convId, {
      model: shape.props.model,
      projectId: shape.props.projectId
    })
  }, [convId, shape.props.model, shape.props.projectId, ensureConversation])

  // Si le user n'a pas encore chargé la liste des modèles (clé API
  // ajoutée après le boot), on la récupère dès qu'elle devient dispo.
  useEffect(() => {
    if (hasKey && models.length === 0 && !modelsLoading) {
      void refreshModels()
    }
  }, [hasKey, models.length, modelsLoading, refreshModels])

  // Le statut wiki vient de useWikiStore — hydraté au boot App + refreshé
  // après chaque mutation. Pas besoin de useEffect local. Juste une ligne
  // consommatrice (useWikiStore ci-dessus) qui cause un rerender auto
  // quand l'utilisateur configure le dossier depuis Settings ou la sidebar.

  function setProjectId(projectId: string | null): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { projectId }
    })
    void updateStoreConversation({ id: convId, projectId })
    setProjectDropdownOpen(false)
  }

  function setModel(modelId: string): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { model: modelId }
    })
    void updateStoreConversation({ id: convId, model: modelId })
  }

  function toggleWebSearch(): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { webSearchEnabled: !shape.props.webSearchEnabled }
    })
  }

  function toggleThinking(): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { thinkingEnabled: !shape.props.thinkingEnabled }
    })
  }

  function toggleWikiContext(): void {
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { wikiContextEnabled: !shape.props.wikiContextEnabled }
    })
  }

  // Injection mémoire Sprint 1 : on passe SCHEMA.md (conventions) + index.md
  // (catalogue) + le CONTENU COMPLET des pages wiki (capé 80 KB sur les
  // plus récentes). Sans le contenu, l'IA répond "je n'ai pas accès" ou
  // pire, hallucine — car SCHEMA décrit COMMENT le système fonctionne mais
  // pas CE QUI est stocké.
  //
  // IMPORTANT : on nettoie chaque page avant injection (strip du frontmatter
  // YAML + de la section ## Sources) pour que l'IA ne voie JAMAIS les refs
  // internes vers raw/xxx.md et ne les cite pas aux utilisateurs. Les raw/
  // sont des artefacts de maintenance pour le Wiki Builder, pas du contenu
  // adressable côté chat.
  async function buildWikiContext(): Promise<string | null> {
    if (!wikiConfigured) return null
    try {
      const [schema, indexContent, wikiEntries] = await Promise.all([
        window.blow.wiki.readSchema() as Promise<string | null>,
        window.blow.wiki.readIndex() as Promise<string | null>,
        window.blow.wiki.listWiki() as Promise<
          Array<{ name: string; size: number; modifiedAt: number }>
        >
      ])
      if (!schema && !indexContent && wikiEntries.length === 0) return null

      const MAX_CHARS = 80_000
      const pageBlocks: string[] = []
      const skipped: string[] = []
      let used = 0
      for (const entry of wikiEntries) {
        try {
          const raw = (await window.blow.wiki.readWiki(entry.name)) as string
          const cleaned = stripInternalMetadata(raw)
          const block = `##### wiki/${entry.name}\n\n${cleaned}`
          if (used + block.length > MAX_CHARS) {
            skipped.push(entry.name)
            continue
          }
          pageBlocks.push(block)
          used += block.length
        } catch {
          skipped.push(entry.name)
        }
      }

      const lines: string[] = [
        '### Mémoire long-terme partagée (BlowWorks)',
        '',
        "Tu as accès à une mémoire persistante compilée à partir de mes conversations passées. Utilise-la comme SOURCE DE VÉRITÉ pour rester cohérent avec les décisions, contextes et références établis.",
        '',
        '**Règles de citation** :',
        "- Cite les pages UNIQUEMENT par leur chemin wiki (`wiki/concepts/xxx.md`, `wiki/connections/yyy.md`, etc.).",
        "- Ne cite JAMAIS de références `raw/…` — ce sont des fichiers internes de maintenance, invisibles à l'utilisateur et supprimables à tout moment.",
        "- Si une information n'apparaît pas dans les pages ci-dessous, dis-le explicitement plutôt que d'inventer.",
        '',
        '#### SCHEMA.md — conventions du wiki',
        '',
        schema && schema.trim().length > 0 ? schema : '(SCHEMA.md absent)',
        ''
      ]
      if (indexContent && indexContent.trim().length > 0) {
        lines.push('#### wiki/index.md — catalogue', '', indexContent, '')
      }
      if (pageBlocks.length > 0) {
        lines.push('#### Pages wiki (contenu compilé)', '', pageBlocks.join('\n\n---\n\n'))
      } else {
        lines.push('#### Pages wiki', '', "(aucune page compilée pour le moment — le Wiki Builder n'a pas encore tourné, ou il n'y a pas de raw à compiler)")
      }
      if (skipped.length > 0) {
        lines.push(
          '',
          `_Pages non inlinées faute de budget (${skipped.length}) : ${skipped.join(', ')}. Demande-les si besoin._`
        )
      }
      return lines.join('\n')
    } catch (e) {
      console.warn('[chat] buildWikiContext failed', e)
      return null
    }
  }

  // Retire les artefacts de maintenance qui ne doivent pas remonter dans
  // les réponses de l'IA à l'utilisateur :
  //   - le YAML frontmatter (--- ... ---) en tête, qui contient `sources:`
  //     pointant vers raw/xxx.md
  //   - toute section `## Sources` terminale qui liste les mêmes raw/
  // Résultat : titre + corps markdown propre, sans mention du fichier raw.
  function stripInternalMetadata(content: string): string {
    // Frontmatter : --- suivi de lignes, jusqu'au prochain --- en début de ligne.
    // Tolérant aux \r\n Windows.
    const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    // Section ## Sources jusqu'au prochain H1/H2 ou fin de fichier.
    // (?:\r?\n##\s|\r?\n#\s|$) = frontière = titre suivant ou EOF.
    const withoutSources = withoutFrontmatter.replace(
      /\r?\n#{1,3}\s*Sources?\b[\s\S]*?(?=\r?\n#{1,3}\s|\s*$)/gi,
      ''
    )
    return withoutSources.trim()
  }

  async function handleSubmit(): Promise<void> {
    const content = draft.trim()
    if (!content || isStreaming || !hasKey) return
    setDraft('')

    const wikiContext = shape.props.wikiContextEnabled ? await buildWikiContext() : null

    await sendMessage(convId, content, {
      model: shape.props.model,
      temperature: defaults.temperature,
      webSearchEnabled: shape.props.webSearchEnabled && apiKeyStatus.tavily,
      wikiContext,
      maxTokens: defaults.maxTokens
    })
  }

  async function handleSynthesize(): Promise<void> {
    if (!wikiConfigured) return
    setSynthState({ kind: 'running' })
    try {
      const r = (await window.blow.agents.runSynthesizer(convId)) as {
        filename: string
        summary: string
      }
      // Cas FLUSH_OK : l'agent a jugé qu'il n'y avait rien à sauver.
      // Le runner retourne filename='' dans ce cas. On affiche un
      // feedback différent pour que l'utilisateur sache que c'est
      // intentionnel, pas une erreur silencieuse.
      if (r.filename === '') {
        setSynthState({ kind: 'flush-ok' })
      } else {
        setSynthState({ kind: 'success', filename: r.filename })
      }
      // Refresh du store : rawCount a changé, on veut que les autres
      // consommateurs (section Mémoire sidebar, Settings > Wiki) voient
      // le nouveau compteur immédiatement.
      void refreshWikiStatus()
      setTimeout(() => setSynthState({ kind: 'idle' }), 4000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSynthState({ kind: 'error', message: msg })
      setTimeout(() => setSynthState({ kind: 'idle' }), 6000)
    }
  }

  function handleCancel(): void {
    void cancelStream(convId)
  }

  // Bouton « + new » : crée une nouvelle conversation SQLite et plugge son id
  // sur la shape courante — pas de nouvelle shape spawnée. L'utilisateur
  // récupère sa conv précédente via le dropdown historique ⏱.
  async function handleNewConversation(): Promise<void> {
    const newId = nanoid()
    try {
      await window.blow.ai.createConversation({
        id: newId,
        model: shape.props.model,
        projectId: shape.props.projectId,
        temperature: defaults.temperature
      })
    } catch (e) {
      console.error('[chat] échec création nouvelle conversation', e)
      return
    }
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { conversationId: newId }
    })
    void refreshAllConversations()
  }

  // Switch de la shape vers une conversation existante — ne touche PAS à
  // l'état d'ouverture du dropdown. `handleSelectConversation` (utilisateur
  // clique sur un item) ferme le dropdown ; `handleDeleteConversation` le
  // laisse ouvert pour enchaîner plusieurs suppressions.
  async function switchToConversation(targetId: string): Promise<void> {
    if (targetId === convId) return
    await loadConversation(targetId)
    hydratedMapRef.current.add(targetId)
    editor.updateShape<ChatShape>({
      id: shape.id,
      type: 'chat',
      props: { conversationId: targetId }
    })
  }

  async function handleSelectConversation(targetId: string): Promise<void> {
    await switchToConversation(targetId)
    setHistoryDropdownOpen(false)
  }

  // Suppression d'une conv depuis le dropdown. Si c'est la conv active, on
  // fallback silencieusement sur la plus récente restante SANS fermer le
  // dropdown — l'utilisateur peut enchaîner plusieurs suppressions. Si la
  // KB est vide après suppression, on recrée une conv vierge pour que la
  // shape ne pointe jamais dans le vide.
  async function handleDeleteConversation(targetId: string): Promise<void> {
    const wasActive = targetId === convId
    await deleteConversationById(targetId)
    if (!wasActive) return

    const remaining = Array.from(allConversations.values())
      .filter((c) => c.id !== targetId)
      .sort((a, b) => b.updatedAt - a.updatedAt)

    if (remaining.length > 0) {
      await switchToConversation(remaining[0].id)
      return
    }

    // Plus rien en DB : conv vierge. `handleNewConversation` ne touche
    // pas à l'état du dropdown — il reste ouvert sur la liste vide.
    await handleNewConversation()
  }

  const disabledReason = !apiKeyStatus.encryptionAvailable
    ? 'Chiffrement système indisponible — impossible de stocker la clé API.'
    : !hasKey
      ? 'Aucune clé OpenRouter configurée — ouvrez Paramètres ⚙ pour la définir.'
      : undefined

  const title = conversation?.conversation.title || 'Nouvelle conversation'
  const messages = conversation?.messages ?? []

  // Surface unifiée Chat ⇄ canvas tldraw : #101011 partout (wrapper, header,
  // zone de saisie) → couture visuelle éliminée. La bordure du wrapper est
  // dynamique (hover / sélection / fade 5 s / projet) — gérée par le hook
  // partagé `useShapeBorderState`.
  const shapeSurface = 'var(--shape-surface, #101011)'
  const borderState = useShapeBorderState(shape.id)
  const borderStyle = getShapeBorderStyle(borderState, assignedProject?.color ?? null)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'hidden',
        background: shapeSurface,
        border: borderStyle.border,
        boxShadow: borderStyle.boxShadow,
        transition: borderStyle.transition,
        borderRadius: 'var(--radius-md, 8px)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Header 28px — pattern TerminalShape : boutons interactifs en
          pointer-events auto, tout le reste laisse tldraw recevoir le
          pointerdown pour drag. */}
      <div
        data-shape-header
        className="relative flex h-7 shrink-0 items-center justify-between gap-2 px-2 text-[11px]"
        style={{
          background: shapeSurface,
          color: 'var(--fg-primary)',
          pointerEvents: 'none'
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="shrink-0"
            style={{ color: 'var(--fg-secondary)', fontSize: 10 }}
          >
            ▣
          </span>
          <span className="truncate text-[11px] text-[var(--fg-primary)]">{title}</span>
        </div>

        <div
          className="flex shrink-0 items-center gap-1"
          style={{ pointerEvents: 'auto' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ModelSelector
            models={models}
            currentModelId={shape.props.model}
            loading={modelsLoading}
            onSelect={setModel}
            onRefresh={() => void refreshModels(true)}
          />

          <div className="relative">
            <button
              type="button"
              onClick={() => setProjectDropdownOpen((v) => !v)}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--bg-tertiary)]"
              style={{
                color: assignedProject ? assignedProject.color : 'var(--fg-muted)'
              }}
              title="Assigner à un projet"
            >
              {assignedProject ? `● ${assignedProject.name}` : '○ projet'}
            </button>
            {projectDropdownOpen && (
              <div
                className="absolute right-0 top-7 z-10 min-w-[180px] overflow-hidden rounded border text-[11px] shadow-lg"
                style={{
                  background: 'var(--bg-secondary)',
                  borderColor: 'var(--border)'
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setProjectId(null)}
                  className="block w-full px-2 py-1.5 text-left text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  ○ Aucun projet
                </button>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProjectId(p.id)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)]"
                    style={{ color: p.color }}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                    <span className="truncate text-[var(--fg-primary)]">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <ConversationHistoryDropdown
            open={historyDropdownOpen}
            onToggle={() => setHistoryDropdownOpen((v) => !v)}
            onClose={() => setHistoryDropdownOpen(false)}
            currentConversationId={convId}
            conversations={allConversations}
            onSelect={(id) => void handleSelectConversation(id)}
            onDelete={(id) => void handleDeleteConversation(id)}
          />

          <button
            type="button"
            onClick={toggleWikiContext}
            disabled={!wikiConfigured}
            className="rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              borderColor: shape.props.wikiContextEnabled
                ? 'var(--fg-secondary)'
                : 'var(--border)',
              color: shape.props.wikiContextEnabled
                ? 'var(--fg-secondary)'
                : 'var(--fg-muted)',
              background: shape.props.wikiContextEnabled ? 'var(--bg-tertiary)' : 'transparent'
            }}
            title={
              !wikiConfigured
                ? 'Wiki non configuré — Paramètres > Wiki'
                : shape.props.wikiContextEnabled
                  ? 'Mémoire wiki injectée dans chaque message (cliquer pour désactiver)'
                  : 'Injecter la mémoire wiki (MEMORY.md + pages) comme contexte système'
            }
          >
            📚
          </button>

          <button
            type="button"
            onClick={() => void handleSynthesize()}
            disabled={!wikiConfigured || synthState.kind === 'running' || messages.length === 0}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
            title={
              !wikiConfigured
                ? 'Wiki non configuré — Paramètres > Wiki'
                : messages.length === 0
                  ? 'Conversation vide — rien à synthétiser'
                  : 'Synthétiser cette conversation dans raw/'
            }
          >
            {synthState.kind === 'running' ? '⏳' : '✦'}
          </button>

          <button
            type="button"
            onClick={() => void handleNewConversation()}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)]"
            title="Nouvelle conversation dans cette shape"
          >
            + new
          </button>
        </div>
      </div>

      {/* Historique scrollable (flex:1 → prend tout l'espace vertical dispo). */}
      <ChatMessageList
        messages={messages}
        streamingContent={activeStream?.content ?? null}
        streamingError={activeStream?.error ?? null}
        streamingCitations={activeStream?.citations}
      />

      {/* Zone de saisie fixée en bas. */}
      <ChatInput
        value={draft}
        onChange={setDraft}
        onSubmit={() => void handleSubmit()}
        onCancel={handleCancel}
        isStreaming={isStreaming}
        disabled={!hasKey || !apiKeyStatus.encryptionAvailable}
        disabledReason={disabledReason}
        webSearchEnabled={shape.props.webSearchEnabled}
        onToggleWebSearch={toggleWebSearch}
        thinkingEnabled={shape.props.thinkingEnabled}
        onToggleThinking={toggleThinking}
      />

      {/* Toast compact de retour agent — flotte au-dessus de la zone de
          saisie, s'efface seul après succès (4s) ou erreur (6s). */}
      {synthState.kind !== 'idle' && (
        <div
          className="pointer-events-none absolute inset-x-3 bottom-[60px] rounded-[var(--radius-sm)] border px-3 py-1.5 text-[11px] shadow-lg"
          style={{
            background: 'var(--bg-secondary)',
            borderColor:
              synthState.kind === 'error'
                ? '#ef4444'
                : synthState.kind === 'success'
                  ? 'var(--fg-secondary)'
                  : synthState.kind === 'flush-ok'
                    ? 'var(--fg-muted)'
                    : 'var(--border)',
            color:
              synthState.kind === 'error'
                ? '#ef4444'
                : synthState.kind === 'success'
                  ? 'var(--fg-secondary)'
                  : 'var(--fg-muted)'
          }}
        >
          {synthState.kind === 'running' && '⏳ Synthèse en cours…'}
          {synthState.kind === 'success' &&
            `✓ Synthèse sauvée dans raw/${synthState.filename}`}
          {synthState.kind === 'flush-ok' &&
            '∅ Rien à sauver — la conversation n\'a pas de substance mémorisable (FLUSH_OK).'}
          {synthState.kind === 'error' && `✗ ${synthState.message}`}
        </div>
      )}
    </div>
  )
}
