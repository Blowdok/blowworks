import { BrowserWindow, DownloadItem, session, shell, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '@shared/ipc-channels.js'
import { getDb } from './db.js'

// Capture des téléchargements initiés par les webviews du navigateur
// intégré (partition `persist:browser`). Persistance SQLite + broadcast
// d'événements de progression au renderer pour l'UI dropdown.
//
// Stratégie : on attache UN listener `will-download` au boot sur la session
// partagée `persist:browser`. Tout webview qui hérite de cette partition
// passe par ce listener — pas besoin d'enregistrer par-shape.

// Map des items en cours pour permettre l'annulation depuis le renderer
// (DownloadItem n'est pas sérialisable et vit côté main).
const activeItems = new Map<string, DownloadItem>()

// Génère un id court — UUID-like pour SQLite primary key.
function generateId(): string {
  return `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

interface DownloadRow {
  id: string
  url: string
  filename: string
  savePath: string
  mimeType: string | null
  totalBytes: number
  receivedBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: number
  endedAt: number | null
}

function broadcast(payload: DownloadRow): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.browser.downloadProgressEvent, payload)
    }
  }
}

function rowFromItem(id: string, item: DownloadItem): DownloadRow {
  const state = item.getState()
  const mappedState: DownloadRow['state'] =
    state === 'completed'
      ? 'completed'
      : state === 'cancelled'
        ? 'cancelled'
        : state === 'interrupted'
          ? 'interrupted'
          : 'progressing'
  return {
    id,
    url: item.getURL(),
    filename: item.getFilename(),
    savePath: item.getSavePath(),
    mimeType: item.getMimeType() || null,
    totalBytes: item.getTotalBytes(),
    receivedBytes: item.getReceivedBytes(),
    state: mappedState,
    startedAt: item.getStartTime() ? Math.round(item.getStartTime() * 1000) : Date.now(),
    endedAt: state === 'progressing' ? null : Date.now()
  }
}

function persist(row: DownloadRow): void {
  getDb()
    .prepare(
      `INSERT INTO browser_downloads
        (id, url, filename, save_path, mime_type, total_bytes, received_bytes,
         state, started_at, ended_at)
       VALUES (@id, @url, @filename, @savePath, @mimeType, @totalBytes,
               @receivedBytes, @state, @startedAt, @endedAt)
       ON CONFLICT(id) DO UPDATE SET
         received_bytes = excluded.received_bytes,
         total_bytes = excluded.total_bytes,
         state = excluded.state,
         ended_at = excluded.ended_at,
         save_path = excluded.save_path,
         filename = excluded.filename`
    )
    .run(row)
}

// Attache le listener de download. Idempotent : ne s'attache qu'une fois
// même si appelé plusieurs fois.
let attached = false

export function attachDownloadHandlers(): void {
  if (attached) return
  attached = true

  const ses = session.fromPartition('persist:browser')

  ses.on('will-download', (_event, item) => {
    const id = generateId()
    activeItems.set(id, item)

    // Save path par défaut = dossier Téléchargements OS. On laisse Electron
    // proposer la save dialog automatiquement (comportement par défaut) —
    // c'est l'attente utilisateur d'un navigateur classique.
    // Si on voulait skip la dialog, on appellerait item.setSavePath(...)
    // ici. On garde le défaut pour ne pas surprendre.

    persist(rowFromItem(id, item))
    broadcast(rowFromItem(id, item))

    item.on('updated', (_e, state) => {
      // 'progressing' | 'interrupted' (pause/reprise)
      void state
      const row = rowFromItem(id, item)
      persist(row)
      broadcast(row)
    })

    item.once('done', (_e, state) => {
      void state
      const row = rowFromItem(id, item)
      persist(row)
      broadcast(row)
      activeItems.delete(id)
    })
  })
}

// ──────────────────────────────────────────────────────────── API consommée par les handlers IPC

export function listDownloads(limit = 200): DownloadRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, url, filename,
              save_path AS savePath,
              mime_type AS mimeType,
              total_bytes AS totalBytes,
              received_bytes AS receivedBytes,
              state, started_at AS startedAt, ended_at AS endedAt
         FROM browser_downloads
         ORDER BY started_at DESC
         LIMIT ?`
    )
    .all(limit) as DownloadRow[]
  return rows
}

export function cancelDownload(id: string): { cancelled: boolean } {
  const item = activeItems.get(id)
  if (!item) return { cancelled: false }
  item.cancel()
  return { cancelled: true }
}

export function openDownload(id: string): { ok: boolean; reason?: string } {
  const row = getDb()
    .prepare('SELECT save_path AS savePath, state FROM browser_downloads WHERE id = ?')
    .get(id) as { savePath: string; state: string } | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.state !== 'completed') return { ok: false, reason: 'not_completed' }
  if (!existsSync(row.savePath)) return { ok: false, reason: 'file_missing' }
  void shell.openPath(row.savePath)
  return { ok: true }
}

export function showDownloadInFolder(id: string): { ok: boolean; reason?: string } {
  const row = getDb()
    .prepare('SELECT save_path AS savePath FROM browser_downloads WHERE id = ?')
    .get(id) as { savePath: string } | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  // Si le fichier a été supprimé, ouvre quand même son dossier parent
  // (comportement Chrome : "Show in folder" reste utile pour aller au
  // dossier même si l'utilisateur a déjà déplacé le fichier).
  if (existsSync(row.savePath)) {
    shell.showItemInFolder(row.savePath)
    return { ok: true }
  }
  // Fallback : si le path est invalide (rare), ouvre le dossier Téléchargements OS.
  const fallback = app.getPath('downloads')
  if (existsSync(fallback)) {
    void shell.openPath(fallback)
    return { ok: true }
  }
  return { ok: false, reason: 'fallback_failed' }
}

export function clearDownloads(): void {
  // Ne supprime QUE les non-progressing pour ne pas perdre la trace des
  // téléchargements en cours.
  getDb().prepare(`DELETE FROM browser_downloads WHERE state != 'progressing'`).run()
}

// Utilitaire: on garde l'export du chemin par défaut pour debug éventuel.
export function getDefaultDownloadsDir(): string {
  return join(app.getPath('downloads'))
}
