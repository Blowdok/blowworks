import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'
import {
  recordHistory,
  patchHistoryEntry,
  listHistory,
  deleteHistoryEntry,
  clearHistory,
  toggleBookmark,
  listBookmarks,
  deleteBookmark,
  updateBookmark
} from '../services/browser-store.js'
import {
  listDownloads,
  cancelDownload,
  openDownload,
  showDownloadInFolder,
  clearDownloads
} from '../services/browser-downloads.js'
import {
  listExtensions,
  loadExtensionFromFolder,
  removeExtensionById
} from '../services/browser-extensions.js'

// Handlers IPC pour le navigateur intégré : historique + favoris globaux.
// Les téléchargements et extensions ont leurs propres modules (Paliers 2/3).

// ──────────────────────────────────────────────────────────── Schémas

const HistoryRecordInput = z.object({
  url: z.string().url(),
  title: z.string().optional().nullable(),
  favicon: z.string().optional().nullable()
})

const HistoryPatchInput = z.object({
  id: z.number().int().positive(),
  title: z.string().optional(),
  favicon: z.string().nullable().optional()
})

const HistoryListInput = z
  .object({
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    search: z.string().max(200).optional()
  })
  .optional()

const HistoryDeleteInput = z.object({
  id: z.number().int().positive()
})

const BookmarkToggleInput = z.object({
  url: z.string().url(),
  title: z.string().optional().nullable(),
  favicon: z.string().optional().nullable()
})

const BookmarkDeleteInput = z.object({
  id: z.number().int().positive()
})

const BookmarkUpdateInput = z.object({
  id: z.number().int().positive(),
  title: z.string().optional(),
  url: z.string().url().optional()
})

// ──────────────────────────────────────────────────────────── Broadcast

// Diffuse un événement à toutes les BrowserWindow ouvertes (multi-window
// future-proof). Utilisé pour notifier les shapes que la liste des
// favoris a changé, afin qu'elles rafraîchissent leur étoile.
function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload ?? null)
    }
  }
}

// ──────────────────────────────────────────────────────────── Handlers

export function registerBrowserHandlers(): void {
  // ── Historique ────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.browser.historyRecord, (_evt, raw) => {
    const input = HistoryRecordInput.parse(raw)
    return recordHistory(input)
  })

  ipcMain.handle(IPC_CHANNELS.browser.historyPatch, (_evt, raw) => {
    const input = HistoryPatchInput.parse(raw)
    patchHistoryEntry(input.id, { title: input.title, favicon: input.favicon })
  })

  ipcMain.handle(IPC_CHANNELS.browser.historyList, (_evt, raw) => {
    const input = HistoryListInput.parse(raw) ?? {}
    return listHistory(input)
  })

  ipcMain.handle(IPC_CHANNELS.browser.historyDelete, (_evt, raw) => {
    const input = HistoryDeleteInput.parse(raw)
    deleteHistoryEntry(input.id)
  })

  ipcMain.handle(IPC_CHANNELS.browser.historyClear, () => {
    clearHistory()
  })

  // ── Favoris ───────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.browser.bookmarkToggle, (_evt, raw) => {
    const input = BookmarkToggleInput.parse(raw)
    const result = toggleBookmark(input)
    broadcast(IPC_CHANNELS.browser.bookmarkChangedEvent)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.browser.bookmarkList, () => {
    return listBookmarks()
  })

  ipcMain.handle(IPC_CHANNELS.browser.bookmarkDelete, (_evt, raw) => {
    const input = BookmarkDeleteInput.parse(raw)
    deleteBookmark(input.id)
    broadcast(IPC_CHANNELS.browser.bookmarkChangedEvent)
  })

  ipcMain.handle(IPC_CHANNELS.browser.bookmarkUpdate, (_evt, raw) => {
    const input = BookmarkUpdateInput.parse(raw)
    updateBookmark(input.id, { title: input.title, url: input.url })
    broadcast(IPC_CHANNELS.browser.bookmarkChangedEvent)
  })

  // ── Téléchargements ───────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.browser.downloadList, () => {
    return listDownloads()
  })

  ipcMain.handle(IPC_CHANNELS.browser.downloadCancel, (_evt, raw) => {
    const id = z.object({ id: z.string().min(1) }).parse(raw).id
    return cancelDownload(id)
  })

  ipcMain.handle(IPC_CHANNELS.browser.downloadOpen, (_evt, raw) => {
    const id = z.object({ id: z.string().min(1) }).parse(raw).id
    return openDownload(id)
  })

  ipcMain.handle(IPC_CHANNELS.browser.downloadShowInFolder, (_evt, raw) => {
    const id = z.object({ id: z.string().min(1) }).parse(raw).id
    return showDownloadInFolder(id)
  })

  ipcMain.handle(IPC_CHANNELS.browser.downloadClear, () => {
    clearDownloads()
  })

  // ── Extensions ────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.browser.extensionList, () => {
    return listExtensions()
  })

  ipcMain.handle(IPC_CHANNELS.browser.extensionLoad, async (_evt, raw) => {
    const folderPath = z.object({ folderPath: z.string().min(1) }).parse(raw).folderPath
    return await loadExtensionFromFolder(folderPath)
  })

  ipcMain.handle(IPC_CHANNELS.browser.extensionRemove, (_evt, raw) => {
    const id = z.object({ id: z.string().min(1) }).parse(raw).id
    return removeExtensionById(id)
  })
}
