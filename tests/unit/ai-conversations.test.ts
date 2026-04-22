import { describe, it, expect } from 'vitest'
import { generateTitleFromFirstMessage } from '../../src/main/services/ai-conversations.js'

// `generateTitleFromFirstMessage` est une fonction pure (pas de DB).
// Tests de non-régression pour garantir des titres courts et propres.

describe('generateTitleFromFirstMessage', () => {
  it('renvoie le message tel quel si ≤ 60 caractères', () => {
    const short = "Explique-moi les hooks React"
    expect(generateTitleFromFirstMessage(short)).toBe(short)
  })

  it('normalise les espaces multiples et sauts de ligne', () => {
    const messy = 'Salut,\n\n  comment   vas-tu ?'
    const out = generateTitleFromFirstMessage(messy)
    expect(out).toBe('Salut, comment vas-tu ?')
  })

  it('tronque sur un mot entier avec ellipsis quand > 60 car', () => {
    const long =
      'Pouvez-vous me décrire en détail le fonctionnement interne des moteurs de rendu React'
    const out = generateTitleFromFirstMessage(long)
    expect(out.length).toBeLessThanOrEqual(61) // 60 + '…'
    expect(out.endsWith('…')).toBe(true)
    // Pas de mot coupé au milieu — doit finir sur un espace précédant '…'
    // (sauf cas extrême sans aucun espace avant 30 caractères).
    const withoutEllipsis = out.slice(0, -1)
    expect(withoutEllipsis.includes(' ')).toBe(true)
  })

  it('force une coupe dure si aucun espace entre 30 et 60', () => {
    const supercalifragilistic =
      'Supercalifragilisticexpialidociousblowdokmegalongtitleforatest123'
    const out = generateTitleFromFirstMessage(supercalifragilistic)
    expect(out.length).toBeLessThanOrEqual(61)
    expect(out.endsWith('…')).toBe(true)
  })
})
