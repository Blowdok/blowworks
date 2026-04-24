import { z } from 'zod'

// Contrats IPC typés et validés (zod) — partagés main/renderer.
// Les CANAUX eux-mêmes sont dans `ipc-channels.ts` (sans zod) pour pouvoir
// être importés par le preload sandboxé.
export { IPC_CHANNELS } from './ipc-channels.js'

// ──────────────────────────────────────────────────────────── Projets
export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/u, 'Couleur hexadécimale attendue (#RRGGBB)'),
  createdAt: z.number().int().nonnegative()
})
export type Project = z.infer<typeof ProjectSchema>

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional()
})
export type CreateProjectInputT = z.infer<typeof CreateProjectInput>

export const UpdateProjectInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional()
})
export type UpdateProjectInputT = z.infer<typeof UpdateProjectInput>

// ──────────────────────────────────────────────────────────── Terminaux
export const ShellKindSchema = z.enum(['powershell', 'cmd', 'bash', 'pwsh'])
export type ShellKindT = z.infer<typeof ShellKindSchema>

export const TerminalSpawnInput = z.object({
  id: z.string().min(1),
  shell: ShellKindSchema.default('powershell'),
  cwd: z.string().min(1),
  cols: z.number().int().min(1).max(1000).default(80),
  rows: z.number().int().min(1).max(1000).default(24),
  env: z.record(z.string(), z.string()).optional(),
  restoreScrollback: z.boolean().default(true)
})
export type TerminalSpawnInputT = z.infer<typeof TerminalSpawnInput>

export const TerminalWriteInput = z.object({
  id: z.string().min(1),
  data: z.string()
})

export const TerminalResizeInput = z.object({
  id: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})

export const TerminalIdInput = z.object({ id: z.string().min(1) })

export const TerminalPersistInput = z.object({
  id: z.string().min(1),
  scrollback: z.string()
})

// ──────────────────────────────────────────────────────────── VSCode
export const VSCodeOpenInput = z.object({
  folder: z.string().min(1)
})
export const VSCodeStatusSchema = z.object({
  running: z.boolean(),
  port: z.number().int().nullable(),
  token: z.string().nullable()
})

// ──────────────────────────────────────────────────────────── Snapshot canvas
export const CanvasSnapshotSchema = z.object({
  snapshotJson: z.string()
})

// ──────────────────────────────────────────────────────────── GitHub (PAT)
// PAT format : `ghp_...` (classic) ou `github_pat_...` (fine-grained).
// Taille minimale laissée généreuse pour absorber les variations de longueur
// entre les deux formats et éviter les faux rejets sur les tokens récents.
export const GitHubSetTokenInput = z.object({
  pat: z.string().regex(/^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/u, 'Format de PAT invalide.')
})
export type GitHubSetTokenInputT = z.infer<typeof GitHubSetTokenInput>

export const GitHubStatusSchema = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  scopes: z.array(z.string()),
  encryptionAvailable: z.boolean(),
  // Indique si un PAT chiffré est stocké (même si `connected: false`).
  // Permet à la UI d'afficher un bouton "Reconnecter rapidement" sans
  // exposer le token en clair.
  hasStoredToken: z.boolean(),
  // 4 derniers caractères du login stocké (mémento pour l'utilisateur).
  lastLoginHint: z.string().nullable()
})
export type GitHubStatusT = z.infer<typeof GitHubStatusSchema>

// ──────────────────────────────────────────────────────────── IA (OpenRouter + Tavily)

// Rôle d'un message : `system` pour les prompts système (injectés par le
// serveur main, jamais stockés en DB sauf si l'utilisateur les définit),
// `user` pour la requête humaine, `assistant` pour la réponse du modèle.
export const AIRoleSchema = z.enum(['user', 'assistant', 'system'])
export type AIRoleT = z.infer<typeof AIRoleSchema>

export const AIMessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: AIRoleSchema,
  content: z.string(),
  model: z.string().nullable().optional(),
  tokensIn: z.number().int().nullable().optional(),
  tokensOut: z.number().int().nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  // Timeline entrelacée (texte + actions IA) sérialisée en JSON. Null
  // pour les messages purement textuels (sans tool_call). Le renderer
  // désérialise pour reconstruire l'historique visuel après un reload.
  segmentsJson: z.string().nullable().optional()
})
export type AIMessageT = z.infer<typeof AIMessageSchema>

export const AIConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  model: z.string().min(1),
  system: z.string().nullable(),
  temperature: z.number().min(0).max(2),
  projectId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})
export type AIConversationT = z.infer<typeof AIConversationSchema>

// Résumé de conversation retourné par `ai.listConversations`. Enrichi d'un
// `messagesCount` pour que le dropdown historique puisse afficher le volume
// sans avoir à charger chaque conversation individuellement.
export const AIConversationSummarySchema = AIConversationSchema.extend({
  messagesCount: z.number().int().nonnegative()
})
export type AIConversationSummaryT = z.infer<typeof AIConversationSummarySchema>

// Entrée pour créer une conversation côté main (id généré par le renderer
// depuis shape.id → 1:1 avec la ChatShape). `system` facultatif.
export const AICreateConversationInput = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  system: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  projectId: z.string().nullable().optional()
})
export type AICreateConversationInputT = z.infer<typeof AICreateConversationInput>

export const AIUpdateConversationInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  model: z.string().min(1).optional(),
  system: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  projectId: z.string().nullable().optional()
})
export type AIUpdateConversationInputT = z.infer<typeof AIUpdateConversationInput>

// Envoi d'un message utilisateur + streaming de la réponse assistant.
// Le main stocke immédiatement le message user, puis démarre le stream
// et émet un chunk par delta jusqu'au `done: true` final qui committe
// le message assistant complet en DB.
export const AISendMessageInput = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  systemPrompt: z.string().nullable().optional(),
  // Contexte wiki (mémoire long-terme) à injecter en « étape 1.5 » entre le
  // systemPrompt utilisateur et les résultats Tavily. Construit côté renderer
  // quand le toggle 📚 est actif, à partir de MEMORY.md + titres de pages wiki.
  wikiContext: z.string().max(200_000).nullable().optional(),
  webSearchEnabled: z.boolean().default(false),
  // Active les tools wiki (read/write/search/rename/delete). Branché au
  // toggle 📚 côté renderer : quand la mémoire est activée pour une conv,
  // l'IA peut naviguer le wiki à la demande au lieu de recevoir un dump.
  wikiToolsEnabled: z.boolean().default(false),
  // Active le reasoning (chain-of-thought) pour les modèles compatibles
  // (Claude 3.7+/4, OpenAI o1/o3, Gemini Thinking, DeepSeek R1, Grok).
  // Branché au toggle 🧠 dans la ChatInput. OpenRouter normalise l'API
  // via `reasoning: { effort: 'medium' }` — les deltas arrivent dans des
  // chunks `reasoningDelta` distincts du contenu principal.
  thinkingEnabled: z.boolean().default(false),
  maxTokens: z.number().int().positive().optional()
})
export type AISendMessageInputT = z.infer<typeof AISendMessageInput>

export const AIConfirmToolCallInput = z.object({
  toolCallId: z.string().min(1),
  approved: z.boolean()
})
export type AIConfirmToolCallInputT = z.infer<typeof AIConfirmToolCallInput>

// Événements tool (Sprint 2) — envoyés en cours de stream quand l'IA
// appelle un tool ou attend une confirmation utilisateur. Les 3 types
// sont mutuellement exclusifs : un chunk en porte au maximum un.
export const AIToolCallEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Zod v4 : z.record(keySchema, valueSchema). Les clés sont des noms
  // d'arguments (strings arbitraires), les valeurs sont n'importe quoi
  // selon le tool appelé.
  arguments: z.record(z.string(), z.unknown())
})
export type AIToolCallEventT = z.infer<typeof AIToolCallEventSchema>

export const AIToolResultEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  result: z.string(),
  error: z.string().optional()
})
export type AIToolResultEventT = z.infer<typeof AIToolResultEventSchema>

// Chunk de streaming. Un seul champ parmi (delta | done | error | toolCall
// | toolResult | toolConfirmNeeded) est présent par chunk. `requestId`
// permet au renderer de router vers la bonne conversation active si
// plusieurs streams tournent en parallèle.
export const AIChunkEventSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  delta: z.string().optional(),
  // Delta du reasoning (chain-of-thought). Émis par les modèles
  // compatibles quand `thinkingEnabled=true`. Le renderer l'accumule
  // dans un segment `reasoning` séparé pour affichage pliable.
  reasoningDelta: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative()
    })
    .optional(),
  // URLs Tavily utilisées pour cette réponse (si webSearchEnabled).
  citations: z.array(z.string().url()).optional(),
  // Tool events (Sprint 2) — voir schémas dédiés pour détail. Le renderer
  // les affiche inline dans le message streamé + déclenche un dialog
  // quand toolConfirmNeeded arrive.
  toolCall: AIToolCallEventSchema.optional(),
  toolResult: AIToolResultEventSchema.optional(),
  toolConfirmNeeded: AIToolCallEventSchema.optional()
})
export type AIChunkEventT = z.infer<typeof AIChunkEventSchema>

// Métadonnées d'un modèle OpenRouter (filtré aux champs utiles à la UI).
// `contextLength` exprimé en tokens, `pricing` en $ par token (OpenRouter
// livre des prix au token, pas au 1M — on convertira à l'affichage).
export const AIModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  contextLength: z.number().int().positive(),
  pricing: z.object({
    prompt: z.number().nonnegative(),
    completion: z.number().nonnegative()
  }),
  modality: z.string().optional()
})
export type AIModelT = z.infer<typeof AIModelSchema>

// Clés API : on stocke OpenRouter (obligatoire) et Tavily (optionnel).
// Le renderer ne reçoit jamais la clé en clair — juste son statut de
// présence et, pour OpenRouter, le compte user vérifié (`account`).
export const AISetApiKeyInput = z.object({
  provider: z.enum(['openrouter', 'tavily']),
  key: z.string().min(10).max(500)
})
export type AISetApiKeyInputT = z.infer<typeof AISetApiKeyInput>

export const AIApiKeyStatusSchema = z.object({
  openrouter: z.boolean(),
  tavily: z.boolean(),
  encryptionAvailable: z.boolean()
})
export type AIApiKeyStatusT = z.infer<typeof AIApiKeyStatusSchema>

// Réglages par défaut pour les nouvelles ChatShapes — servent aussi de
// fallback quand l'utilisateur n'a pas encore touché le sélecteur modèle.
export const AIDefaultsSchema = z.object({
  model: z.string().min(1).default('anthropic/claude-sonnet-4-6'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(4096)
})
export type AIDefaultsT = z.infer<typeof AIDefaultsSchema>

// ──────────────────────────────────────────────────────────── Agents IA

// Un agent = une unité d'exécution one-shot (vs ChatShape = interaction
// multi-tours). `kind` distingue les agents système (synthesizer,
// wiki_builder, lint, researcher) des agents libres ('custom') que
// l'utilisateur créera.
export const AgentKindSchema = z.enum([
  'synthesizer',
  'wiki_builder',
  'lint',
  'researcher',
  'custom'
])
export type AgentKindT = z.infer<typeof AgentKindSchema>

// Bornes max tokens : 128 min (quelque chose de significatif), 200k max
// (contexte max de Claude / GPT-4 Turbo). Le runtime caspe de toute
// façon selon le modèle choisi côté OpenRouter.
const MAX_TOKENS_MIN = 128
const MAX_TOKENS_MAX = 200_000

export const AgentSchema = z.object({
  id: z.string().min(1),
  kind: AgentKindSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  model: z.string().min(1),
  systemPrompt: z.string().min(1).max(50_000),
  // 0.0 = déterministe, 2.0 = très créatif. Valeur par agent (les runners
  // la passent à OpenRouter). Default 0.7 pour les agents custom, 0.2-0.3
  // pour les agents système (cf. seed dans db.ts).
  temperature: z.number().min(0).max(2),
  // Taille max de la réponse générée. Bornée pour éviter qu'un prompt
  // utilisateur cassé ne demande 500k tokens et fasse exploser la facture.
  maxTokens: z.number().int().min(MAX_TOKENS_MIN).max(MAX_TOKENS_MAX),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})
export type AgentT = z.infer<typeof AgentSchema>

export const AgentCreateInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  model: z.string().min(1),
  systemPrompt: z.string().min(1).max(50_000),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(MAX_TOKENS_MIN).max(MAX_TOKENS_MAX).optional(),
  enabled: z.boolean().optional()
})
export type AgentCreateInputT = z.infer<typeof AgentCreateInput>

export const AgentUpdateInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).max(50_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(MAX_TOKENS_MIN).max(MAX_TOKENS_MAX).optional(),
  enabled: z.boolean().optional()
})
export type AgentUpdateInputT = z.infer<typeof AgentUpdateInput>

// Input pour runSynthesizer : cible une conversation à synthétiser.
export const AgentRunSynthesizerInput = z.object({
  conversationId: z.string().min(1)
})
export type AgentRunSynthesizerInputT = z.infer<typeof AgentRunSynthesizerInput>

// Input pour runFileBackResponse : cible un message assistant précis
// à transformer en page wiki qa/. Utilisé par le bouton "📥 Filer" sur
// chaque MessageBubble assistant du chat.
export const AgentRunFileBackInput = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1)
})
export type AgentRunFileBackInputT = z.infer<typeof AgentRunFileBackInput>

export const AgentFileBackResultSchema = z.object({
  filename: z.string().min(1),
  logEntry: z.string()
})
export type AgentFileBackResultT = z.infer<typeof AgentFileBackResultSchema>

// Résultat d'un run Synthétiseur : chemin de la note écrite + contenu
// pour feedback UI.
export const AgentSynthesizerResultSchema = z.object({
  filename: z.string().min(1),
  summary: z.string()
})
export type AgentSynthesizerResultT = z.infer<typeof AgentSynthesizerResultSchema>

// Résultat d'un run Wiki Builder : opérations appliquées.
export const AgentWikiBuilderOperationSchema = z.object({
  op: z.enum(['create', 'update', 'rename']),
  filename: z.string().min(1),
  bytes: z.number().int().nonnegative()
})
export type AgentWikiBuilderOperationT = z.infer<typeof AgentWikiBuilderOperationSchema>

export const AgentWikiBuilderResultSchema = z.object({
  operations: z.array(AgentWikiBuilderOperationSchema)
})
export type AgentWikiBuilderResultT = z.infer<typeof AgentWikiBuilderResultSchema>

// Résultat du lint (Sprint 4) — utilisé par le bouton Health check.
export const LintIssueSchema = z.object({
  kind: z.enum([
    'orphan',
    'broken-ref',
    'ghost-concept',
    'stale',
    'sparse',
    'orphan-source',
    'contradiction',
    'inconsistency'
  ]),
  severity: z.enum(['low', 'medium', 'high']),
  pages: z.array(z.string()),
  description: z.string()
})
export type LintIssueT = z.infer<typeof LintIssueSchema>

export const LintReportSchema = z.object({
  runAt: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  issues: z.array(LintIssueSchema),
  summary: z.string()
})
export type LintReportT = z.infer<typeof LintReportSchema>

// Rapport d'exécution du Researcher (Sprint 5) : remonté au renderer pour
// afficher un toast synthétique après actualisation web.
export const ResearchResultSchema = z.object({
  queriesMade: z.number().int().nonnegative(),
  operations: z.array(
    z.object({
      op: z.string(),
      filename: z.string(),
      bytes: z.number().int().nonnegative()
    })
  ),
  logEntry: z.string()
})
export type ResearchResultT = z.infer<typeof ResearchResultSchema>

// ──────────────────────────────────────────────────────────── Wiki (mémoire FS)

// Statut du dossier wiki : soit pas configuré du tout (`folderPath: null`),
// soit configuré et initialisé (structure raw/ wiki/ MEMORY.md en place).
// `initialized` peut être false si l'utilisateur a supprimé manuellement
// le dossier — les handlers list/read/write retestent et peuvent re-init.
export const WikiFolderStatusSchema = z.object({
  folderPath: z.string().nullable(),
  initialized: z.boolean(),
  rawCount: z.number().int().nonnegative(),
  wikiCount: z.number().int().nonnegative()
})
export type WikiFolderStatusT = z.infer<typeof WikiFolderStatusSchema>

// Item listé dans raw/ ou wiki/. Pas le contenu, juste métadata pour UI.
export const WikiEntrySchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative()
})
export type WikiEntryT = z.infer<typeof WikiEntrySchema>

// Graphe du wiki : noeuds = pages, arêtes = wikilinks. Construit côté
// main par `wiki-graph.ts` et consommé par le renderer (GraphSidebarSection,
// futurs composants d'exploration).
export const WikiGraphNodeSchema = z.object({
  id: z.string().min(1), // chemin relatif ex: concepts/pagemark.md
  title: z.string(),
  type: z.string(),
  importance: z.string(),
  statut: z.string(),
  backlinks: z.number().int().nonnegative(),
  outlinks: z.number().int().nonnegative()
})
export type WikiGraphNodeT = z.infer<typeof WikiGraphNodeSchema>

export const WikiGraphEdgeSchema = z.object({
  source: z.string().min(1),
  // `target` null = wikilink orphelin (pointe vers une page inexistante).
  // Utile pour afficher en pointillé côté renderer.
  target: z.string().nullable(),
  targetSlug: z.string()
})
export type WikiGraphEdgeT = z.infer<typeof WikiGraphEdgeSchema>

export const WikiGraphDataSchema = z.object({
  nodes: z.array(WikiGraphNodeSchema),
  edges: z.array(WikiGraphEdgeSchema)
})
export type WikiGraphDataT = z.infer<typeof WikiGraphDataSchema>

// Validation stricte du nom de fichier wiki : .md uniquement, sous-dossiers
// autorisés (segments séparés par /), pas de `..`, caractère ASCII printable
// + accents + tiret + underscore. `resolveSafePath` fait le double-check
// côté FS pour refuser toute évasion hors du dossier configuré.
export const WikiFilenameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[\w\-À-ſ][\w\-À-ſ. ]*(?:\/[\w\-À-ſ][\w\-À-ſ. ]*)*\.md$/u,
    'Nom de fichier invalide : lettres/chiffres/espace/tiret, sous-dossiers OK, extension .md'
  )
  .refine((s) => !s.includes('..') && !s.startsWith('/') && !s.includes('\\'), {
    message: 'Chemin non sécurisé (traversal interdit)'
  })

export const WikiReadInput = z.object({
  name: WikiFilenameSchema
})
export type WikiReadInputT = z.infer<typeof WikiReadInput>

export const WikiWriteInput = z.object({
  name: WikiFilenameSchema,
  content: z.string().max(5_000_000) // 5 MiB de contenu max — largement suffisant pour du markdown
})
export type WikiWriteInputT = z.infer<typeof WikiWriteInput>

// IPC_CHANNELS : voir `./ipc-channels.ts` (réexporté en haut du fichier).
