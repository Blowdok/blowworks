import { describe, it, expect } from 'vitest'
import { formatSearchForPrompt } from '../../src/main/services/tavily.js'

// `formatSearchForPrompt` est une fonction pure : composition d'un message
// système à partir de la réponse Tavily. Tests de non-régression sur le
// format attendu côté LLM.

describe('formatSearchForPrompt', () => {
  it('inclut la question originale', () => {
    const out = formatSearchForPrompt('capitale de la France', {
      answer: null,
      results: []
    })
    expect(out).toContain('capitale de la France')
  })

  it('inclut la réponse rapide quand présente', () => {
    const out = formatSearchForPrompt('q', {
      answer: 'Paris est la capitale.',
      results: []
    })
    expect(out).toContain('Paris est la capitale.')
    expect(out).toContain('Réponse rapide')
  })

  it('liste les sources au format markdown', () => {
    const out = formatSearchForPrompt('q', {
      answer: null,
      results: [
        { title: 'Wikipedia', url: 'https://fr.wikipedia.org/x', content: 'Paris…', score: 0.9 },
        { title: 'Le Monde', url: 'https://lemonde.fr/y', content: 'Capitale…', score: 0.8 }
      ]
    })
    expect(out).toContain('[Wikipedia](https://fr.wikipedia.org/x)')
    expect(out).toContain('[Le Monde](https://lemonde.fr/y)')
  })

  it('tronque les contenus à 500 caractères', () => {
    const longContent = 'x'.repeat(1000)
    const out = formatSearchForPrompt('q', {
      answer: null,
      results: [{ title: 't', url: 'https://x.com', content: longContent, score: 1 }]
    })
    // On doit voir 500 x à la suite mais pas 501
    expect(out).toContain('x'.repeat(500))
    expect(out.split('x'.repeat(501)).length).toBe(1)
  })

  it("inclut les règles d'utilisation des sources", () => {
    const out = formatSearchForPrompt('q', { answer: null, results: [] })
    expect(out).toContain('Règles de réponse')
    expect(out).toContain('[titre](url)')
  })

  it('gère 0 résultats sans crasher', () => {
    const out = formatSearchForPrompt('rien', { answer: null, results: [] })
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })
})
