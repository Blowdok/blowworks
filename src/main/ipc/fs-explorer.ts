import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'
import {
  listDirectory,
  getQuickAccess,
  openFile,
  renameEntry,
  trashEntry,
  openInNativeExplorer
} from '../services/fs-explorer.js'
import { showShellContextMenu } from '../services/shell-context-menu.js'

// Handlers IPC pour l'ExplorerShape. Tous les paramètres sont validés
// minimalement (type de string) côté main : on ne fait pas confiance au
// renderer. La validation Zod stricte est superflue ici car les schémas
// des payloads sont triviaux et rejetés naturellement par le typage TS
// du preload + la défense en profondeur des opérations fs (qui rejettent
// d'elles-mêmes les chemins invalides).

export function registerFsExplorerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.fs.list, async (_evt, raw: { path: string }) => {
    if (!raw || typeof raw.path !== 'string') {
      return { ok: false, reason: 'payload-invalide' }
    }
    return listDirectory(raw.path)
  })

  ipcMain.handle(IPC_CHANNELS.fs.quickAccess, () => {
    return getQuickAccess()
  })

  ipcMain.handle(IPC_CHANNELS.fs.open, async (_evt, raw: { path: string }) => {
    if (!raw || typeof raw.path !== 'string') {
      return { ok: false, reason: 'payload-invalide' }
    }
    return openFile(raw.path)
  })

  ipcMain.handle(
    IPC_CHANNELS.fs.rename,
    async (_evt, raw: { oldPath: string; newName: string }) => {
      if (!raw || typeof raw.oldPath !== 'string' || typeof raw.newName !== 'string') {
        return { ok: false, reason: 'payload-invalide' }
      }
      return renameEntry(raw.oldPath, raw.newName)
    }
  )

  ipcMain.handle(IPC_CHANNELS.fs.trash, async (_evt, raw: { path: string }) => {
    if (!raw || typeof raw.path !== 'string') {
      return { ok: false, reason: 'payload-invalide' }
    }
    return trashEntry(raw.path)
  })

  ipcMain.handle(
    IPC_CHANNELS.fs.openInExplorer,
    async (_evt, raw: { path: string }) => {
      if (!raw || typeof raw.path !== 'string') {
        return { ok: false, reason: 'payload-invalide' }
      }
      return openInNativeExplorer(raw.path)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.fs.shellContextMenu,
    async (
      event,
      raw: { path: string; screenX: number; screenY: number }
    ) => {
      if (
        !raw ||
        typeof raw.path !== 'string' ||
        typeof raw.screenX !== 'number' ||
        typeof raw.screenY !== 'number'
      ) {
        return { ok: false, invoked: false, reason: 'payload-invalide' }
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return { ok: false, invoked: false, reason: 'fenetre-introuvable' }
      }
      const parentHwndBuffer = win.getNativeWindowHandle()
      return showShellContextMenu({
        parentHwndBuffer,
        path: raw.path,
        screenX: raw.screenX,
        screenY: raw.screenY
      })
    }
  )
}
