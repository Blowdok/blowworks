import { describe, it, expect } from 'vitest'
import {
  buildUserMessageContent,
  parseAttachmentsJson,
  textFromModelContent
} from '../../src/shared/ai-attachments.js'

describe('buildUserMessageContent', () => {
  it('retourne le texte seul sans pièce jointe', () => {
    expect(buildUserMessageContent('hello', [])).toBe('hello')
  })

  it('combine texte et images', () => {
    const parts = buildUserMessageContent('regarde', [
      { type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,abc' }
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'regarde' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
    ])
  })

  it('injecte un fichier texte dans le prompt', () => {
    const out = buildUserMessageContent('analyse', [
      { type: 'text', name: 'notes.md', content: '# Titre' }
    ])
    expect(typeof out).toBe('string')
    expect(out).toContain('notes.md')
    expect(out).toContain('# Titre')
  })

  it('mélange texte, fichier et image', () => {
    const parts = buildUserMessageContent('voir', [
      { type: 'text', name: 'ctx.txt', content: 'contexte' },
      { type: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,x' }
    ])
    expect(Array.isArray(parts)).toBe(true)
    const textPart = (parts as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')
    expect(textPart?.text).toContain('ctx.txt')
    expect(textPart?.text).toContain('contexte')
  })
})

describe('textFromModelContent', () => {
  it('extrait le texte des parts multimodaux', () => {
    const text = textFromModelContent([
      { type: 'text', text: 'partie 1' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
      { type: 'text', text: 'partie 2' }
    ])
    expect(text).toBe('partie 1\npartie 2')
  })
})

describe('parseAttachmentsJson', () => {
  it('retourne un tableau vide si null', () => {
    expect(parseAttachmentsJson(null)).toEqual([])
  })

  it('parse le format v2 typé', () => {
    const raw = JSON.stringify([
      { type: 'text', name: 'a.txt', content: 'hello' }
    ])
    expect(parseAttachmentsJson(raw)).toHaveLength(1)
  })

  it('migre le format v1 image sans type', () => {
    const raw = JSON.stringify([{ name: 'x.png', dataUrl: 'data:image/png;base64,aa' }])
    const parsed = parseAttachmentsJson(raw)
    expect(parsed[0]).toMatchObject({ type: 'image', name: 'x.png' })
  })
})
