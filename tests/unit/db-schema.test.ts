import { describe, it, expect } from 'vitest'
import {
  ProjectSchema,
  CanvasSnapshotSchema,
  VSCodeOpenInput
} from '../../src/shared/ipc-contract.js'

// Validation de la cohérence des schémas zod utilisés par les handlers IPC.
describe('schémas IPC additionnels', () => {
  describe('ProjectSchema', () => {
    it('valide un projet complet', () => {
      const now = Date.now()
      const res = ProjectSchema.parse({
        id: 'abc123',
        name: 'Mon projet',
        color: '#00FFFF',
        createdAt: now
      })
      expect(res.createdAt).toBe(now)
    })

    it('rejette un id vide', () => {
      expect(() =>
        ProjectSchema.parse({ id: '', name: 'x', color: '#000000', createdAt: 0 })
      ).toThrow()
    })
  })

  describe('CanvasSnapshotSchema', () => {
    it('accepte un snapshot JSON sérialisé', () => {
      const res = CanvasSnapshotSchema.parse({ snapshotJson: '{"shapes":[]}' })
      expect(res.snapshotJson).toContain('shapes')
    })
  })

  describe('VSCodeOpenInput', () => {
    it('rejette un dossier vide', () => {
      expect(() => VSCodeOpenInput.parse({ folder: '' })).toThrow()
    })

    it('accepte un chemin Windows', () => {
      const res = VSCodeOpenInput.parse({ folder: 'C:/Users/test/projet' })
      expect(res.folder).toBe('C:/Users/test/projet')
    })
  })
})
