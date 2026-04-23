import { ipcMain, dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS, WikiReadInput, WikiWriteInput } from '@shared/ipc-contract.js'
import * as wiki from '../services/wiki-fs.js'

// Handlers IPC pour la mémoire Wiki FS. Tous les handlers retournent le
// nouveau statut après mutation pour que le renderer n'ait pas à refetcher
// séparément — pattern déjà utilisé par github.setToken.

export function registerWikiHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.wiki.getFolder, () => wiki.getWikiStatus())

  // Ouvre le picker OS + sauve le setting + init la structure. Atomique du
  // point de vue du renderer : un seul appel fait tout. Retourne `null` si
  // l'utilisateur annule, sinon le nouveau statut.
  ipcMain.handle(IPC_CHANNELS.wiki.chooseFolder, async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choisir un dossier pour la mémoire Wiki',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return wiki.setWikiFolder(result.filePaths[0])
  })

  ipcMain.handle(IPC_CHANNELS.wiki.listRaw, () => wiki.listRaw())
  ipcMain.handle(IPC_CHANNELS.wiki.listWiki, () => wiki.listWiki())

  ipcMain.handle(IPC_CHANNELS.wiki.readRaw, (_evt, raw) => {
    const { name } = WikiReadInput.parse(raw)
    return wiki.readRaw(name)
  })
  ipcMain.handle(IPC_CHANNELS.wiki.readWiki, (_evt, raw) => {
    const { name } = WikiReadInput.parse(raw)
    return wiki.readWiki(name)
  })
  ipcMain.handle(IPC_CHANNELS.wiki.readMemoryTemplate, () => wiki.readMemoryTemplate())

  ipcMain.handle(IPC_CHANNELS.wiki.writeRaw, async (_evt, raw) => {
    const { name, content } = WikiWriteInput.parse(raw)
    await wiki.writeRaw(name, content)
    return { ok: true }
  })
  ipcMain.handle(IPC_CHANNELS.wiki.writeWiki, async (_evt, raw) => {
    const { name, content } = WikiWriteInput.parse(raw)
    await wiki.writeWiki(name, content)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.wiki.openFolderInExplorer, async () => {
    const err = await wiki.openFolderInExplorer()
    return { ok: err === '', error: err || null }
  })
}
