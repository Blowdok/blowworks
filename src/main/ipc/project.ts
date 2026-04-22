import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import {
  IPC_CHANNELS,
  CreateProjectInput,
  UpdateProjectInput,
  type Project
} from '@shared/ipc-contract.js'
import { getDb } from '../services/db.js'

// Palette par défaut : cyan néon conforme à la palette BlowWorks.
const DEFAULT_COLOR = '#00FFFF'

interface ProjectRow {
  id: string
  name: string
  color: string
  created_at: number
}

function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, color: r.color, createdAt: r.created_at }
}

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.project.list, (): Project[] => {
    const rows = getDb()
      .prepare('SELECT id, name, color, created_at FROM projects ORDER BY created_at DESC')
      .all() as ProjectRow[]
    return rows.map(rowToProject)
  })

  ipcMain.handle(IPC_CHANNELS.project.create, (_evt, raw): Project => {
    const input = CreateProjectInput.parse(raw)
    const project: Project = {
      id: nanoid(12),
      name: input.name.trim(),
      color: input.color ?? DEFAULT_COLOR,
      createdAt: Date.now()
    }
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, color, created_at) VALUES (@id, @name, @color, @createdAt)'
      )
      .run(project)
    return project
  })

  ipcMain.handle(IPC_CHANNELS.project.update, (_evt, raw): Project | null => {
    const input = UpdateProjectInput.parse(raw)
    const existing = getDb()
      .prepare('SELECT id, name, color, created_at FROM projects WHERE id = ?')
      .get(input.id) as ProjectRow | undefined
    if (!existing) return null
    const updated: Project = {
      id: existing.id,
      name: input.name ?? existing.name,
      color: input.color ?? existing.color,
      createdAt: existing.created_at
    }
    getDb().prepare('UPDATE projects SET name = @name, color = @color WHERE id = @id').run(updated)
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.project.delete, (_evt, raw): boolean => {
    const { id } = UpdateProjectInput.pick({ id: true }).parse(raw)
    const res = getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
    return res.changes > 0
  })
}
