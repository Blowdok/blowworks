import { oneShotChat, hasOpenRouterKey } from './openrouter.js'

// Reformule un brouillon utilisateur via un modèle rapide et peu coûteux.

const OPTIMIZER_MODEL = 'google/gemini-2.5-flash-lite'
const OPTIMIZER_SYSTEM = [
  'Tu reformules le message de l\'utilisateur pour le rendre plus clair, précis et actionnable',
  'pour un assistant IA généraliste.',
  'Garde la langue du message original.',
  'Conserve l\'intention et les contraintes explicites.',
  'Retourne UNIQUEMENT le prompt optimisé, sans préambule ni commentaire.'
].join(' ')

export async function optimizePrompt(text: string): Promise<{ optimized: string; error: string | null }> {
  if (!hasOpenRouterKey()) {
    return { optimized: '', error: 'Clé OpenRouter manquante — configurez-la dans Réglages.' }
  }

  const trimmed = text.trim()
  if (!trimmed) {
    return { optimized: '', error: 'Rien à optimiser : saisissez d\'abord un message.' }
  }

  const result = await oneShotChat({
    model: OPTIMIZER_MODEL,
    systemPrompt: OPTIMIZER_SYSTEM,
    userPrompt: trimmed,
    temperature: 0.3,
    maxTokens: 2048,
    timeoutMs: 60_000
  })

  if (result.error) {
    return { optimized: '', error: result.error }
  }

  const optimized = result.content.trim()
  if (!optimized) {
    return { optimized: '', error: 'Le modèle n\'a renvoyé aucun texte.' }
  }

  return { optimized, error: null }
}
