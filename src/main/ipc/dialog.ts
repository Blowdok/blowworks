import { dialog, ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'

// Limite de taille d'image pour le fond de canvas. Au-delà on refuse :
// l'image est stockée en dataURL dans la table `settings` SQLite (clé
// `canvas.background.dataUrl`), donc une image trop grosse alourdit la
// DB et chaque hydrate du store. 2 Mio est un compromis raisonnable
// (couvre largement une photo HD compressée).
const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024
const MAX_CHAT_TEXT_BYTES = 200 * 1024

const TEXT_FILE_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'yml',
  'yaml',
  'log',
  'xml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'html',
  'css',
  'ini',
  'toml',
  'env',
  'conf',
  'cfg'
]

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp'
}

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

  // Sélection d'une image image (fond de canvas). Retourne `{dataUrl, name}`
  // — le main lit le fichier, vérifie la taille, et encode en dataURL base64
  // pour que le renderer puisse l'utiliser directement comme `src` sans
  // dépendre d'un protocole custom. `null` si l'utilisateur annule.
  ipcMain.handle(
    IPC_CHANNELS.dialog.pickImage,
    async (evt, raw): Promise<{ dataUrl: string; name: string } | null> => {
      const options = (raw ?? {}) as { title?: string }
      const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
      const result = await dialog.showOpenDialog(win!, {
        title: options.title ?? 'Choisir une image',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const filePath = result.filePaths[0]
      const ext = path.extname(filePath).toLowerCase()
      const mime = MIME_BY_EXT[ext]
      if (!mime) {
        throw new Error(`Format d'image non supporté : ${ext}`)
      }

      const stat = await fs.stat(filePath)
      if (stat.size > MAX_BACKGROUND_BYTES) {
        const sizeMib = (stat.size / 1024 / 1024).toFixed(1)
        const limitMib = (MAX_BACKGROUND_BYTES / 1024 / 1024).toFixed(1)
        throw new Error(
          `Image trop volumineuse (${sizeMib} Mio, limite ${limitMib} Mio). Compresse-la d'abord.`
        )
      }

      const buf = await fs.readFile(filePath)
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      return { dataUrl, name: path.basename(filePath) }
    }
  )

  // Fichier texte pour pièce jointe chat (UTF-8, taille limitée).
  ipcMain.handle(
    IPC_CHANNELS.dialog.pickTextFile,
    async (evt, raw): Promise<{ name: string; content: string } | null> => {
      const options = (raw ?? {}) as { title?: string }
      const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined
      const result = await dialog.showOpenDialog(win!, {
        title: options.title ?? 'Joindre un fichier texte',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'Fichiers texte', extensions: TEXT_FILE_EXTENSIONS }]
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const filePath = result.filePaths[0]
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_CHAT_TEXT_BYTES) {
        const sizeKib = (stat.size / 1024).toFixed(0)
        const limitKib = (MAX_CHAT_TEXT_BYTES / 1024).toFixed(0)
        throw new Error(
          `Fichier trop volumineux (${sizeKib} Ko, limite ${limitKib} Ko).`
        )
      }

      const content = await fs.readFile(filePath, 'utf8')
      return { name: path.basename(filePath), content }
    }
  )
}
