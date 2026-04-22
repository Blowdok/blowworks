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
  createdAt: z.number().int().nonnegative()
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
  webSearchEnabled: z.boolean().default(false),
  maxTokens: z.number().int().positive().optional()
})
export type AISendMessageInputT = z.infer<typeof AISendMessageInput>

// Chunk de streaming. Un seul champ à la fois (delta OU done OU error).
// `requestId` permet au renderer de router vers la bonne conversation
// active si plusieurs streams tournent en parallèle.
export const AIChunkEventSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  delta: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative()
    })
    .optional(),
  // URLs Tavily utilisées pour cette réponse (si webSearchEnabled).
  // Émises dans le chunk final `done: true` pour affichage en CitationsList.
  citations: z.array(z.string().url()).optional()
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

// IPC_CHANNELS : voir `./ipc-channels.ts` (réexporté en haut du fichier).
