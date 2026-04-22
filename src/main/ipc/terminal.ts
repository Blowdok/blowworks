import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  TerminalSpawnInput,
  TerminalWriteInput,
  TerminalResizeInput,
  TerminalIdInput,
  TerminalPersistInput
} from '@shared/ipc-contract.js'
import { ptyManager } from '../services/pty-manager.js'
import { getDb } from '../services/db.js'

interface TerminalRow {
  id: string
  shell: string
  cwd: string
  env_json: string | null
  cols: number
  rows: number
  scrollback_blob: string | null
  last_active: number
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.terminal.spawn, (_evt, raw) => {
    const input = TerminalSpawnInput.parse(raw)

    // Persister la configuration pour restauration ultérieure.
    getDb()
      .prepare(
        `INSERT INTO terminals (id, shell, cwd, env_json, cols, rows, last_active)
         VALUES (@id, @shell, @cwd, @env, @cols, @rows, @now)
         ON CONFLICT(id) DO UPDATE SET
           shell = @shell, cwd = @cwd, env_json = @env, cols = @cols, rows = @rows, last_active = @now`
      )
      .run({
        id: input.id,
        shell: input.shell,
        cwd: input.cwd,
        env: input.env ? JSON.stringify(input.env) : null,
        cols: input.cols,
        rows: input.rows,
        now: Date.now()
      })

    ptyManager.spawn({
      id: input.id,
      shell: input.shell,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env
    })

    // Renvoyer le scrollback persisté si demandé.
    if (input.restoreScrollback) {
      const row = getDb()
        .prepare('SELECT scrollback_blob FROM terminals WHERE id = ?')
        .get(input.id) as Pick<TerminalRow, 'scrollback_blob'> | undefined
      return { scrollback: row?.scrollback_blob ?? null }
    }
    return { scrollback: null }
  })

  ipcMain.handle(IPC_CHANNELS.terminal.write, (_evt, raw) => {
    const input = TerminalWriteInput.parse(raw)
    ptyManager.write(input.id, input.data)
  })

  ipcMain.handle(IPC_CHANNELS.terminal.resize, (_evt, raw) => {
    const input = TerminalResizeInput.parse(raw)
    ptyManager.resize(input.id, input.cols, input.rows)
    getDb()
      .prepare('UPDATE terminals SET cols = ?, rows = ?, last_active = ? WHERE id = ?')
      .run(input.cols, input.rows, Date.now(), input.id)
  })

  ipcMain.handle(IPC_CHANNELS.terminal.kill, (_evt, raw) => {
    const input = TerminalIdInput.parse(raw)
    ptyManager.kill(input.id)
  })

  ipcMain.handle(IPC_CHANNELS.terminal.persist, (_evt, raw) => {
    const input = TerminalPersistInput.parse(raw)
    getDb()
      .prepare('UPDATE terminals SET scrollback_blob = ?, last_active = ? WHERE id = ?')
      .run(input.scrollback, Date.now(), input.id)
  })

  ipcMain.handle(IPC_CHANNELS.terminal.restore, (_evt, raw) => {
    const input = TerminalIdInput.parse(raw)
    const row = getDb()
      .prepare('SELECT scrollback_blob FROM terminals WHERE id = ?')
      .get(input.id) as Pick<TerminalRow, 'scrollback_blob'> | undefined
    return { scrollback: row?.scrollback_blob ?? null }
  })
}
