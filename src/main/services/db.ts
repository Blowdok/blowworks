import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Accès SQLite synchrone. Une seule instance partagée côté main.

let dbInstance: Database.Database | null = null

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Base de données non initialisée. Appeler initDatabase() en premier.')
  }
  return dbInstance
}

export function initDatabase(): void {
  if (dbInstance) return

  const userData = app.getPath('userData')
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })

  const dbPath = join(userData, 'blowworks.sqlite')
  dbInstance = new Database(dbPath)
  dbInstance.pragma('journal_mode = WAL')
  dbInstance.pragma('foreign_keys = ON')

  runMigrations(dbInstance)
}

// Migrations intégrées : on embarque le SQL inline pour simplifier le déploiement.
function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_shapes (
      id          TEXT PRIMARY KEY,
      project_id  TEXT,
      type        TEXT NOT NULL,
      config_json TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS terminals (
      id              TEXT PRIMARY KEY,
      shell           TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      env_json        TEXT,
      cols            INTEGER NOT NULL DEFAULT 80,
      rows            INTEGER NOT NULL DEFAULT 24,
      scrollback_blob TEXT,
      last_active     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_json TEXT NOT NULL,
      saved_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Conversations IA (1 ligne = 1 ChatShape sur le canvas).
    -- L'id correspond à shape.id pour bénéficier du même identifiant
    -- côté tldraw et côté SQLite — pas de mapping à maintenir.
    -- project_id = FK souple vers projects (pas de cascade) : on garde
    -- la conversation même si le projet est supprimé (cohérent avec
    -- le comportement de canvas_shapes.project_id).
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      model       TEXT NOT NULL,
      system      TEXT,
      temperature REAL NOT NULL DEFAULT 0.7,
      project_id  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    -- Messages d'une conversation, append-only. CASCADE sur suppression
    -- de conversation — quand l'utilisateur supprime la ChatShape,
    -- tous les messages partent avec (UX propre, pas d'orphelins).
    CREATE TABLE IF NOT EXISTS ai_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      model           TEXT,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id);
  `)
}
