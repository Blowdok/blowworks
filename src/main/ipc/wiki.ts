import { ipcMain, dialog, BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, WikiReadInput, WikiWriteInput } from '@shared/ipc-contract.js'
import * as wiki from '../services/wiki-fs.js'
import { buildWikiGraphData } from '../services/wiki-graph.js'

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
  ipcMain.handle(IPC_CHANNELS.wiki.readSchema, () => wiki.readSchema())
  ipcMain.handle(IPC_CHANNELS.wiki.readIndex, () => wiki.readIndex())
  ipcMain.handle(IPC_CHANNELS.wiki.readLog, () => wiki.readLog())
  // Alias deprecated (preload continue de l'exposer pour compat renderer).
  ipcMain.handle(IPC_CHANNELS.wiki.readMemoryTemplate, () => wiki.readSchema())

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
  ipcMain.handle(IPC_CHANNELS.wiki.writeIndex, async (_evt, raw) => {
    const { content } = z.object({ content: z.string().max(1_000_000) }).parse(raw)
    await wiki.writeIndex(content)
    return { ok: true }
  })
  ipcMain.handle(IPC_CHANNELS.wiki.appendLog, async (_evt, raw) => {
    const { entry } = z.object({ entry: z.string().min(1).max(10_000) }).parse(raw)
    await wiki.appendLog(entry)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.wiki.openFolderInExplorer, async () => {
    const err = await wiki.openFolderInExplorer()
    return { ok: err === '', error: err || null }
  })

  ipcMain.handle(IPC_CHANNELS.wiki.openRawInExplorer, async () => {
    const err = await wiki.openRawInExplorer()
    return { ok: err === '', error: err || null }
  })

  // Import manuel : ouvre un file picker multi-sélection + copie chaque
  // fichier compatible dans raw/. Retourne le détail par fichier (succès
  // ou erreur) pour que la UI affiche un récap honnête.
  ipcMain.handle(IPC_CHANNELS.wiki.importToRaw, async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Importer dans raw/',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: 'Notes markdown / texte', extensions: ['md', 'markdown', 'txt'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, results: [] }
    }
    const results = await wiki.importToRaw(result.filePaths)
    return { canceled: false, results }
  })

  ipcMain.handle(IPC_CHANNELS.wiki.getGraph, () => buildWikiGraphData())
}
