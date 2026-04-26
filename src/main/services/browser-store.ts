import { getDb } from './db.js'

// Service d'accès SQLite pour l'historique et les favoris du navigateur
// intégré (BrowserShape). Données GLOBALES — partagées entre tous les
// projets et toutes les BrowserShapes, comme Chrome. Synchrone (better-sqlite3).

// ──────────────────────────────────────────────────────────── Types

export interface HistoryEntry {
  id: number
  url: string
  title: string
  favicon: string | null
  visitedAt: number
}

export interface BookmarkEntry {
  id: number
  url: string
  title: string
  favicon: string | null
  sortOrder: number
  createdAt: number
}

// ──────────────────────────────────────────────────────────── Historique

// Insère une entrée d'historique pour une nouvelle navigation. Renvoie
// l'id généré pour permettre au caller (BrowserTabWebview) de patcher
// ensuite le titre et le favicon une fois reçus de Chromium.
export function recordHistory(input: {
  url: string
  title?: string | null
  favicon?: string | null
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO browser_history (url, title, favicon, visited_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.url, input.title ?? '', input.favicon ?? null, Date.now())
  return Number(result.lastInsertRowid)
}

export function patchHistoryEntry(
  id: number,
  patch: { title?: string; favicon?: string | null }
): void {
  const sets: string[] = []
  const params: unknown[] = []
  if (typeof patch.title === 'string') {
    sets.push('title = ?')
    params.push(patch.title)
  }
  if (patch.favicon !== undefined) {
    sets.push('favicon = ?')
    params.push(patch.favicon)
  }
  if (sets.length === 0) return
  params.push(id)
  getDb().prepare(`UPDATE browser_history SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

// Liste paginée + recherche full-text simple (LIKE sur url + titre).
// Limite par défaut 200 — l'UI peut paginer si besoin.
export function listHistory(opts: {
  limit?: number
  offset?: number
  search?: string
}): HistoryEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const offset = Math.max(opts.offset ?? 0, 0)
  const search = (opts.search ?? '').trim()

  const rows = search.length > 0
    ? getDb()
        .prepare(
          `SELECT id, url, title, favicon, visited_at AS visitedAt
             FROM browser_history
             WHERE url LIKE ? OR title LIKE ?
             ORDER BY visited_at DESC
             LIMIT ? OFFSET ?`
        )
        .all(`%${search}%`, `%${search}%`, limit, offset)
    : getDb()
        .prepare(
          `SELECT id, url, title, favicon, visited_at AS visitedAt
             FROM browser_history
             ORDER BY visited_at DESC
             LIMIT ? OFFSET ?`
        )
        .all(limit, offset)

  return rows as HistoryEntry[]
}

export function deleteHistoryEntry(id: number): void {
  getDb().prepare('DELETE FROM browser_history WHERE id = ?').run(id)
}

export function clearHistory(): void {
  getDb().prepare('DELETE FROM browser_history').run()
}

// ──────────────────────────────────────────────────────────── Favoris

// Ajoute si absent, retire si présent (toggle convention Chrome ⭐).
// Renvoie l'état FINAL pour que l'UI puisse refléter le bouton.
export function toggleBookmark(input: {
  url: string
  title?: string | null
  favicon?: string | null
}): { bookmarked: boolean } {
  const db = getDb()
  const existing = db
    .prepare('SELECT id FROM browser_bookmarks WHERE url = ?')
    .get(input.url) as { id: number } | undefined

  if (existing) {
    db.prepare('DELETE FROM browser_bookmarks WHERE id = ?').run(existing.id)
    return { bookmarked: false }
  }

  // Trouve le sort_order max pour ajouter à la fin de la liste.
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM browser_bookmarks')
    .get() as { m: number }
  const sortOrder = (maxRow?.m ?? 0) + 1

  db.prepare(
    `INSERT INTO browser_bookmarks (url, title, favicon, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(input.url, input.title ?? '', input.favicon ?? null, sortOrder, Date.now())

  return { bookmarked: true }
}

export function listBookmarks(): BookmarkEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, url, title, favicon,
              sort_order AS sortOrder,
              created_at AS createdAt
         FROM browser_bookmarks
         ORDER BY sort_order ASC, created_at ASC`
    )
    .all()
  return rows as BookmarkEntry[]
}

export function isBookmarked(url: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM browser_bookmarks WHERE url = ?')
    .get(url) as { x: number } | undefined
  return !!row
}

export function deleteBookmark(id: number): void {
  getDb().prepare('DELETE FROM browser_bookmarks WHERE id = ?').run(id)
}

export function updateBookmark(
  id: number,
  patch: { title?: string; url?: string }
): void {
  const sets: string[] = []
  const params: unknown[] = []
  if (typeof patch.title === 'string') {
    sets.push('title = ?')
    params.push(patch.title)
  }
  if (typeof patch.url === 'string') {
    sets.push('url = ?')
    params.push(patch.url)
  }
  if (sets.length === 0) return
  params.push(id)
  getDb().prepare(`UPDATE browser_bookmarks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}
