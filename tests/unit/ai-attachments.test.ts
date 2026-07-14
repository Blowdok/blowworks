import { describe, it, expect } from 'vitest'
import {
  buildMultimodalUserContent,
  parseAttachmentsJson,
  textFromModelContent
} from '../../src/shared/ai-attachments.js'

describe('buildMultimodalUserContent', () => {
  it('retourne le texte seul sans pièce jointe', () => {
    expect(buildMultimodalUserContent('hello', [])).toBe('hello')
  })

  it('combine texte et images', () => {
    const parts = buildMultimodalUserContent('regarde', [
      { name: 'a.png', dataUrl: 'data:image/png;base64,abc' }
    ])
    expect(Array.isArray(parts)).toBe(true)
    expect(parts).toEqual([
      { type: 'text', text: 'regarde' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
    ])
  })

  it('accepte image seule sans texte', () => {
    const parts = buildMultimodalUserContent('', [
      { name: 'b.jpg', dataUrl: 'data:image/jpeg;base64,xyz' }
    ])
    expect(parts).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xyz' } }
    ])
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

  it('parse un JSON valide', () => {
    const raw = JSON.stringify([{ name: 'x.png', dataUrl: 'data:image/png;base64,aa' }])
    expect(parseAttachmentsJson(raw)).toHaveLength(1)
  })
})
