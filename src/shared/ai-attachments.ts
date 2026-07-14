import { z } from 'zod'

// Pièces jointes du chat IA : images (multimodal OpenRouter) et fichiers
// texte (injectés dans le prompt). Stockées en JSON dans
// `ai_messages.attachments_json`.

export const MAX_CHAT_ATTACHMENTS = 4
export const MAX_TEXT_ATTACHMENT_CHARS = 80_000

const ImageAttachmentSchema = z.object({
  type: z.literal('image'),
  name: z.string().min(1),
  dataUrl: z.string().startsWith('data:image/')
})

const TextAttachmentSchema = z.object({
  type: z.literal('text'),
  name: z.string().min(1),
  content: z.string().max(MAX_TEXT_ATTACHMENT_CHARS)
})

// Rétrocompat v1 : `{ name, dataUrl }` sans champ `type`.
const LegacyImageAttachmentSchema = z.object({
  name: z.string().min(1),
  dataUrl: z.string().startsWith('data:image/')
})

export const AIChatAttachmentSchema = z.union([
  ImageAttachmentSchema,
  TextAttachmentSchema,
  LegacyImageAttachmentSchema.transform((legacy) => ({
    type: 'image' as const,
    name: legacy.name,
    dataUrl: legacy.dataUrl
  }))
])

export type AIChatAttachmentT = z.infer<typeof ImageAttachmentSchema> | z.infer<typeof TextAttachmentSchema>

export const AIChatAttachmentsSchema = z.array(AIChatAttachmentSchema).max(MAX_CHAT_ATTACHMENTS)

// Alias historiques (PR #2).
export const AIImageAttachmentSchema = ImageAttachmentSchema
export type AIImageAttachmentT = z.infer<typeof ImageAttachmentSchema>

export type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function formatTextFileBlock(name: string, content: string): string {
  return `\n\n--- Fichier joint : ${name} ---\n${content}\n--- Fin du fichier ---`
}

export function buildUserMessageContent(
  text: string,
  attachments: readonly AIChatAttachmentT[]
): string | OpenRouterContentPart[] {
  if (attachments.length === 0) return text

  const textBlocks: string[] = []
  const trimmed = text.trim()
  if (trimmed) textBlocks.push(trimmed)

  for (const att of attachments) {
    if (att.type === 'text') {
      textBlocks.push(formatTextFileBlock(att.name, att.content))
    }
  }

  const combinedText = textBlocks.join('')
  const images = attachments.filter((a): a is z.infer<typeof ImageAttachmentSchema> => a.type === 'image')

  if (images.length === 0) {
    return combinedText
  }

  const parts: OpenRouterContentPart[] = []
  if (combinedText) parts.push({ type: 'text', text: combinedText })
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
  }
  return parts.length === 1 && parts[0].type === 'text' ? combinedText : parts
}

/** @deprecated Utiliser `buildUserMessageContent`. */
export function buildMultimodalUserContent(
  text: string,
  attachments: readonly { dataUrl: string }[]
): string | OpenRouterContentPart[] {
  return buildUserMessageContent(
    text,
    attachments.map((a, i) => ({
      type: 'image' as const,
      name: `image-${i + 1}`,
      dataUrl: a.dataUrl
    }))
  )
}

export function textFromModelContent(content: string | OpenRouterContentPart[] | null): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function parseAttachmentsJson(raw: string | null | undefined): AIChatAttachmentT[] {
  if (!raw) return []
  try {
    return AIChatAttachmentsSchema.parse(JSON.parse(raw))
  } catch {
    return []
  }
}

export function hasAttachments(attachments: readonly AIChatAttachmentT[]): boolean {
  return attachments.length > 0
}
