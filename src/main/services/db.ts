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

    -- Agents IA configurables (lot 3). Deux agents système seedés au
    -- 1er boot : 'synthesizer' et 'wiki_builder'. Les agents 'custom'
    -- sont créés par l'utilisateur depuis Settings > Agents. Les system
    -- agents ne peuvent pas être supprimés (garde-fou côté service),
    -- seulement édités (model, systemPrompt, enabled).
    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      model          TEXT NOT NULL,
      system_prompt  TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
  `)

  seedSystemAgents(db)
}

// Seed des deux agents système obligatoires. Idempotent : n'insère que si
// la ligne correspondante n'existe pas encore (clé primaire fixe pour les
// agents système → `agent.synthesizer`, `agent.wiki_builder`).
function seedSystemAgents(db: Database.Database): void {
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO agents (id, kind, name, description, model, system_prompt,
                         enabled, created_at, updated_at)
    VALUES (@id, @kind, @name, @description, @model, @system_prompt,
            @enabled, @created_at, @updated_at)
    ON CONFLICT(id) DO NOTHING
  `)

  insert.run({
    id: 'agent.synthesizer',
    kind: 'synthesizer',
    name: 'Synthétiseur',
    description:
      'Condense une conversation en une synthèse courte destinée à la mémoire long-terme.',
    model: 'anthropic/claude-sonnet-4-6',
    system_prompt:
      "Tu es l'agent Synthétiseur de BlowWorks. Ton rôle est de lire une conversation entre un utilisateur et une IA, puis d'en extraire l'essentiel dans une note Markdown courte (200 à 500 mots) destinée à être stockée comme mémoire long-terme.\n\nStructure ta réponse ainsi :\n1. Un titre H1 descriptif.\n2. Un paragraphe \"Contexte\" (2-3 phrases).\n3. Une section \"Points clés\" sous forme de liste à puces.\n4. Une section \"Décisions / Conclusions\" si applicable.\n5. Une section \"Questions ouvertes\" si applicable.\n\nNe recopie PAS la conversation. Capture les faits saillants, décisions et références. Écris au présent, en français.",
    enabled: 1,
    created_at: now,
    updated_at: now
  })

  insert.run({
    id: 'agent.wiki_builder',
    kind: 'wiki_builder',
    name: 'Wiki Builder',
    description:
      'Analyse les synthèses brutes du dossier raw/ et les refactor en pages structurées reliées par des wiki-links.',
    model: 'anthropic/claude-sonnet-4-6',
    system_prompt:
      "Tu es l'agent Wiki Builder de BlowWorks. Tu reçois en entrée une liste de synthèses brutes (raw/) et la liste des pages wiki existantes. Ton rôle est de produire une liste d'opérations JSON qui fait évoluer le wiki vers une représentation cohérente et bien structurée.\n\nConventions :\n- Une page wiki = un concept (projet, personne, décision, référence technique).\n- Nom des pages : kebab-case.md.\n- Liens inter-pages : [[nom-page]] (sans l'extension).\n- Fusionne les doublons, renomme si besoin.\n\nRetourne UNIQUEMENT un JSON valide de la forme :\n{\n  \"operations\": [\n    { \"op\": \"create\" | \"update\", \"filename\": \"nom.md\", \"content\": \"...\" }\n  ]\n}\n\nPas de commentaires hors du JSON. Contenu des pages en français, au présent.",
    enabled: 1,
    created_at: now,
    updated_at: now
  })
}
