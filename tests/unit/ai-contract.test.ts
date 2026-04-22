import { describe, it, expect } from 'vitest'
import {
  AISendMessageInput,
  AIChunkEventSchema,
  AIModelSchema,
  AICreateConversationInput,
  AISetApiKeyInput,
  AIDefaultsSchema
} from '../../src/shared/ipc-contract.js'

// Valide les contrats IPC IA — garantit que toute entrée venant du renderer
// est strictement typée avant d'atteindre la logique métier.

describe('AISendMessageInput', () => {
  it('applique les défauts sur température et web search', () => {
    const res = AISendMessageInput.parse({
      conversationId: 'shape:conv1',
      content: 'Bonjour',
      model: 'anthropic/claude-sonnet-4-6'
    })
    expect(res.temperature).toBe(0.7)
    expect(res.webSearchEnabled).toBe(false)
  })

  it('rejette un message vide', () => {
    expect(() =>
      AISendMessageInput.parse({
        conversationId: 'c1',
        content: '',
        model: 'x/y'
      })
    ).toThrow()
  })

  it('rejette une température hors bornes', () => {
    expect(() =>
      AISendMessageInput.parse({
        conversationId: 'c1',
        content: 'hi',
        model: 'x/y',
        temperature: 3
      })
    ).toThrow()
  })
})

describe('AIChunkEventSchema', () => {
  it('accepte un delta seul', () => {
    const res = AIChunkEventSchema.parse({
      requestId: 'req1',
      conversationId: 'c1',
      delta: 'Salut'
    })
    expect(res.delta).toBe('Salut')
  })

  it('accepte un chunk final avec usage + citations', () => {
    const res = AIChunkEventSchema.parse({
      requestId: 'req1',
      conversationId: 'c1',
      done: true,
      usage: { promptTokens: 10, completionTokens: 20 },
      citations: ['https://example.com/article']
    })
    expect(res.done).toBe(true)
    expect(res.citations).toHaveLength(1)
  })

  it('rejette une citation non-URL', () => {
    expect(() =>
      AIChunkEventSchema.parse({
        requestId: 'r',
        conversationId: 'c',
        done: true,
        citations: ['pas une url']
      })
    ).toThrow()
  })
})

describe('AIModelSchema', () => {
  it('valide un modèle OpenRouter normalisé', () => {
    const res = AIModelSchema.parse({
      id: 'anthropic/claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      contextLength: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 }
    })
    expect(res.contextLength).toBe(200000)
    expect(res.pricing.prompt).toBe(0.000003)
  })

  it('rejette un contextLength non entier positif', () => {
    expect(() =>
      AIModelSchema.parse({
        id: 'x/y',
        name: 'z',
        contextLength: -1,
        pricing: { prompt: 0, completion: 0 }
      })
    ).toThrow()
  })
})

describe('AICreateConversationInput', () => {
  it('applique la température par défaut', () => {
    const res = AICreateConversationInput.parse({
      id: 'shape:abc',
      model: 'anthropic/claude-sonnet-4-6'
    })
    expect(res.temperature).toBe(0.7)
  })

  it('accepte un projectId null', () => {
    const res = AICreateConversationInput.parse({
      id: 'shape:abc',
      model: 'x/y',
      projectId: null
    })
    expect(res.projectId).toBeNull()
  })
})

describe('AISetApiKeyInput', () => {
  it('accepte openrouter', () => {
    const res = AISetApiKeyInput.parse({
      provider: 'openrouter',
      key: 'sk-or-v1-abcdef1234567890'
    })
    expect(res.provider).toBe('openrouter')
  })

  it('accepte tavily', () => {
    const res = AISetApiKeyInput.parse({
      provider: 'tavily',
      key: 'tvly-abcdef1234567890'
    })
    expect(res.provider).toBe('tavily')
  })

  it('rejette un provider inconnu', () => {
    expect(() =>
      AISetApiKeyInput.parse({ provider: 'openai', key: 'x'.repeat(20) })
    ).toThrow()
  })

  it('rejette une clé trop courte', () => {
    expect(() =>
      AISetApiKeyInput.parse({ provider: 'openrouter', key: 'short' })
    ).toThrow()
  })
})

describe('AIDefaultsSchema', () => {
  it('applique les défauts sur tous les champs', () => {
    const res = AIDefaultsSchema.parse({})
    expect(res.model).toBe('anthropic/claude-sonnet-4-6')
    expect(res.temperature).toBe(0.7)
    expect(res.maxTokens).toBe(4096)
  })

  it('rejette une temperature négative', () => {
    expect(() => AIDefaultsSchema.parse({ temperature: -0.1 })).toThrow()
  })
})
