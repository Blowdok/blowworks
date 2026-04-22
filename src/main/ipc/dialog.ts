import { dialog, ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'

// Handlers IPC pour les boîtes de dialogue natives OS (file picker, etc.).
// Générique — réutilisable pour VSCode, terminal cwd, import/export...

export function registerDialogHandlers(): void {
  // Ouvre l'explorateur Windows en mode « sélection de dossier » et retourne
  // le chemin choisi (ou `null` si l'utilisateur annule).
  ipcMain.handle(IPC_CHANNELS.dialog.pickFolder, async (evt, raw): Promise<string | null> => {
    const options = (raw ?? {}) as { title?: string; defaultPath?: string }
    const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: options.title ?? 'Sélectionner un dossier',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
