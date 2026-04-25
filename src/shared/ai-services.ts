// Catalogue des assistants IA web embarquables dans BlowWorks via la
// BrowserShape (webview Electron). Source unique partagée renderer / main.
//
// Ajouter un service = ajouter une entrée à `AI_SERVICES` ; le menu IA
// du Header le récupère automatiquement.
//
// Critère d'inclusion : interface chat web publique, accessible sans
// app desktop dédiée. Le webview gère l'auth (cookies persistés via la
// partition `persist:browser`, comme tout autre site dans BrowserShape).

export type AIServiceId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'perplexity'
  | 'mistral'
  | 'grok'
  | 'copilot'
  | 'deepseek'
  | 'notebooklm'
  | 'huggingchat'

export interface AIService {
  readonly id: AIServiceId
  readonly label: string
  readonly homepage: string
  // Description courte affichée en sous-titre dans le menu (1 ligne).
  readonly tagline: string
  // Couleur de marque approximative — utilisée pour la pastille avec
  // l'initiale dans le menu, pour repérage visuel rapide.
  readonly color: string
}

export const AI_SERVICES: readonly AIService[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    homepage: 'https://chatgpt.com/',
    tagline: 'OpenAI — GPTs, artifacts, mode vocal',
    color: '#10a37f'
  },
  {
    id: 'claude',
    label: 'Claude',
    homepage: 'https://claude.ai/',
    tagline: 'Anthropic — projets, artifacts, longs contextes',
    color: '#cc785c'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    homepage: 'https://gemini.google.com/',
    tagline: 'Google — Deep Research, intégration Workspace',
    color: '#4285f4'
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    homepage: 'https://www.perplexity.ai/',
    tagline: 'Recherche web sourcée en temps réel',
    color: '#20808d'
  },
  {
    id: 'mistral',
    label: 'Le Chat',
    homepage: 'https://chat.mistral.ai/',
    tagline: 'Mistral AI — modèles européens, code Codestral',
    color: '#fa520f'
  },
  {
    id: 'grok',
    label: 'Grok',
    homepage: 'https://grok.com/',
    tagline: 'xAI — accès direct au flux X / actualité',
    color: '#1f2937'
  },
  {
    id: 'copilot',
    label: 'Copilot',
    homepage: 'https://copilot.microsoft.com/',
    tagline: 'Microsoft — recherche Bing intégrée',
    color: '#0078d4'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    homepage: 'https://chat.deepseek.com/',
    tagline: 'Modèles open-weights performants en raisonnement',
    color: '#4d6bfe'
  },
  {
    id: 'notebooklm',
    label: 'NotebookLM',
    homepage: 'https://notebooklm.google.com/',
    tagline: 'Google — synthèse audio + Q/R sur tes documents',
    color: '#f9ab00'
  },
  {
    id: 'huggingchat',
    label: 'HuggingChat',
    homepage: 'https://huggingface.co/chat/',
    tagline: 'HuggingFace — multi-modèles open-source',
    color: '#ff9d00'
  }
] as const

export function getAIService(id: AIServiceId): AIService {
  const found = AI_SERVICES.find((s) => s.id === id)
  if (!found) {
    throw new Error(`Service IA inconnu : ${id}`)
  }
  return found
}
