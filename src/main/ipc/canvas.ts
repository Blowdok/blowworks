import { ipcMain } from 'electron'
import { IPC_CHANNELS, CanvasSnapshotSchema } from '@shared/ipc-contract.js'
import { getDb } from '../services/db.js'

// Snapshots tldraw : on conserve les 10 derniers pour récupération manuelle.
const MAX_SNAPSHOTS = 10

export function registerCanvasHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.canvas.saveSnapshot, (_evt, raw) => {
    const input = CanvasSnapshotSchema.parse(raw)
    const db = getDb()
    db.prepare('INSERT INTO canvas_snapshots (snapshot_json, saved_at) VALUES (?, ?)').run(
      input.snapshotJson,
      Date.now()
    )
    // Rotation : on garde seulement les N derniers.
    db.prepare(
      `DELETE FROM canvas_snapshots WHERE id NOT IN (
         SELECT id FROM canvas_snapshots ORDER BY saved_at DESC LIMIT ?
       )`
    ).run(MAX_SNAPSHOTS)
  })

  ipcMain.handle(IPC_CHANNELS.canvas.loadSnapshot, () => {
    const row = getDb()
      .prepare('SELECT snapshot_json FROM canvas_snapshots ORDER BY saved_at DESC LIMIT 1')
      .get() as { snapshot_json: string } | undefined
    return row?.snapshot_json ?? null
  })
}
