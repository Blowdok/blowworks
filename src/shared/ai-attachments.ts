import { z } from 'zod'

// Pièces jointes image pour le chat IA (multimodal via OpenRouter).
// Stockées en JSON dans `ai_messages.attachments_json` et envoyées au
// modèle au format OpenAI `image_url`.

export const AIImageAttachmentSchema = z.object({
  name: z.string().min(1),
  dataUrl: z.string().startsWith('data:image/')
})
export type AIImageAttachmentT = z.infer<typeof AIImageAttachmentSchema>

export const AIImageAttachmentsSchema = z.array(AIImageAttachmentSchema).max(4)

export type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export function buildMultimodalUserContent(
  text: string,
  attachments: readonly AIImageAttachmentT[]
): string | OpenRouterContentPart[] {
  if (attachments.length === 0) return text
  const parts: OpenRouterContentPart[] = []
  const trimmed = text.trim()
  if (trimmed) parts.push({ type: 'text', text: trimmed })
  for (const att of attachments) {
    parts.push({ type: 'image_url', image_url: { url: att.dataUrl } })
  }
  return parts
}

export function textFromModelContent(content: string | OpenRouterContentPart[] | null): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function parseAttachmentsJson(raw: string | null | undefined): AIImageAttachmentT[] {
  if (!raw) return []
  try {
    return AIImageAttachmentsSchema.parse(JSON.parse(raw))
  } catch {
    return []
  }
}
