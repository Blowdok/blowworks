import { describe, it, expect } from 'vitest'
import {
  CreateProjectInput,
  TerminalSpawnInput,
  ShellKindSchema
} from '../../src/shared/ipc-contract.js'

// Validation stricte des contrats IPC : protège contre les messages mal formés.
describe('ipc-contract', () => {
  describe('CreateProjectInput', () => {
    it('accepte un nom simple', () => {
      const res = CreateProjectInput.parse({ name: 'Mon projet' })
      expect(res.name).toBe('Mon projet')
    })

    it('rejette un nom vide', () => {
      expect(() => CreateProjectInput.parse({ name: '' })).toThrow()
    })

    it('rejette une couleur invalide', () => {
      expect(() =>
        CreateProjectInput.parse({ name: 'x', color: 'rouge' })
      ).toThrow()
    })

    it('accepte une couleur hex bien formée', () => {
      const res = CreateProjectInput.parse({ name: 'x', color: '#00FFFF' })
      expect(res.color).toBe('#00FFFF')
    })
  })

  describe('TerminalSpawnInput', () => {
    it('applique les valeurs par défaut', () => {
      const res = TerminalSpawnInput.parse({ id: 'shape:1', cwd: 'C:/' })
      expect(res.shell).toBe('powershell')
      expect(res.cols).toBe(80)
      expect(res.rows).toBe(24)
      expect(res.restoreScrollback).toBe(true)
    })

    it('rejette cols hors bornes', () => {
      expect(() =>
        TerminalSpawnInput.parse({ id: 'x', cwd: 'C:/', cols: 0, rows: 24 })
      ).toThrow()
    })
  })

  describe('ShellKindSchema', () => {
    it.each(['powershell', 'cmd', 'bash', 'pwsh'] as const)('accepte %s', (s) => {
      expect(ShellKindSchema.parse(s)).toBe(s)
    })

    it('rejette un shell inconnu', () => {
      expect(() => ShellKindSchema.parse('zsh')).toThrow()
    })
  })
})
