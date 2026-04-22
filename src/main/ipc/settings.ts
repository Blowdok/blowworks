import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '@shared/ipc-contract.js'
import { getDb } from '../services/db.js'

const SettingGetInput = z.object({ key: z.string().min(1) })
const SettingSetInput = z.object({ key: z.string().min(1), value: z.string() })

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.settings.get, (_evt, raw) => {
    const { key } = SettingGetInput.parse(raw)
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  })

  ipcMain.handle(IPC_CHANNELS.settings.set, (_evt, raw) => {
    const { key, value } = SettingSetInput.parse(raw)
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  })
}
