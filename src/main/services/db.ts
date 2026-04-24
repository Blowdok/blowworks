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

  addAgentColumnsIfMissing(db)
  seedSystemAgents(db)
}

// Migrations ALTER TABLE conditionnelles pour la table `agents`. Ajoute
// les colonnes qui manquent à un schéma d'install antérieur. SQLite n'a
// pas de `ADD COLUMN IF NOT EXISTS` avant 3.35 chez tout le monde — on
// lit `pragma_table_info` et on décide à la main.
function addAgentColumnsIfMissing(db: Database.Database): void {
  const cols = db
    .prepare(`SELECT name FROM pragma_table_info('agents')`)
    .all() as Array<{ name: string }>
  const has = (n: string): boolean => cols.some((c) => c.name === n)

  if (!has('temperature')) {
    db.exec(`ALTER TABLE agents ADD COLUMN temperature REAL NOT NULL DEFAULT 0.7`)
  }
  if (!has('max_tokens')) {
    // 4096 : défaut raisonnable pour un agent conversationnel. Les
    // runners système bumpent ensuite via le seed (2048 Synthétiseur,
    // 16384 Wiki Builder — cf. seedSystemAgents).
    db.exec(`ALTER TABLE agents ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 4096`)
  }
  if (!has('customized')) {
    // Flag utilisateur (Sprint 4) : quand un agent est modifié via
    // l'UI (updateAgent), ce flag passe à 1. `upgradeSystemPromptsIfNeeded`
    // skip alors cet agent aux prochains bumps → protège les tunings
    // de l'utilisateur contre les écrasements silencieux.
    db.exec(`ALTER TABLE agents ADD COLUMN customized INTEGER NOT NULL DEFAULT 0`)
  }
}

// Version des prompts système — incrémentée à chaque upgrade majeur.
// Au boot, si le setting `agents.promptsVersion` est inférieur à cette
// constante, on force la mise à jour des prompts des agents système. Ça
// écrase les customisations utilisateur — acceptable en early dev, à
// revoir quand on ajoutera un champ `customized` côté table.
const SYSTEM_PROMPTS_VERSION = 8

// Prompts v2 (Sprint 1) — alignés sur l'analogie compiler + sentinel
// FLUSH_OK + JSON schema-driven (pattern claude-memory-compiler adapté).
const SYNTHESIZER_PROMPT_V2 = `Tu es l'agent Synthétiseur de BlowWorks.

Tu reçois une conversation entre un utilisateur et une IA. Ton rôle : produire une synthèse structurée qui sera ajoutée au dossier \`raw/\` et consommée plus tard par le Wiki Builder.

**N'UTILISE AUCUN OUTIL.** Retourne UNIQUEMENT du texte markdown plain.

## Règles non-négociables

- Aucun nom propre, date, chiffre ou citation INVENTÉ. Si l'info vient de toi et non de la conversation, préfixe-la \`(inféré)\`.
- Distingue faits REPORTÉS par l'utilisateur (certains) des hypothèses/opinions de l'IA (\`(à-vérifier)\`).
- Français uniquement. Pas de tiret cadratin —, pas de "il est important de noter", pas de "en conclusion".

## Format EXACT de la réponse

Affiche UNIQUEMENT les sections qui ont du contenu :

\`\`\`
**Contexte:** [Une ligne sur ce que l'utilisateur faisait]

**Échanges clés:**
- [Q&A ou discussions qui valent d'être gardées]

**Décisions prises:**
- [Décisions avec leur justification]

**Leçons apprises:**
- [Pièges, patterns, insights découverts]

**Questions ouvertes:**
- [Follow-ups ou TODOs mentionnés]

**Pages suggérées:**
- type=concept|projet|personne|outil|décision · titre: "..." · raison: "pourquoi cette page émerge"
\`\`\`

## À IGNORER systématiquement

- Appels d'outils routiniers, lectures de fichier
- Contenu trivial ou évident
- Allers-retours de clarification sans substance

## Cas rien-à-sauver

Si RIEN ne vaut d'être mémorisé, réponds EXACTEMENT : \`FLUSH_OK\`

(Pas de phrase avant ou après. Juste ce token.)`

const WIKI_BUILDER_PROMPT_V2 = `Tu es l'agent Wiki Builder de BlowWorks — un "compilateur de connaissance".

Tu reçois dans ton prompt :
1. Le contenu INTÉGRAL de \`SCHEMA.md\` (la spec du compilateur)
2. Le contenu actuel de \`wiki/index.md\`
3. Le contenu complet de TOUS les articles \`wiki/**/*.md\` existants
4. Les fichiers \`raw/*.md\` à compiler

## Règles

1. Nom de fichier : **kebab-case.md**, accents supprimés. Place dans \`concepts/\`, \`connections/\` ou \`qa/\` selon nature. **Le chemin est relatif au dossier wiki/** — n'écris PAS de prefix \`wiki/\` dans \`filename\`, le runner l'ajoute automatiquement.
2. Chaque article a un frontmatter YAML COMPLET conforme au SCHEMA. Le champ \`liens_forts\` liste les \`[[wikilinks]]\` les plus importants (minimum 2 si d'autres pages existent).
3. Structure d'article : \`# Titre\` / \`> [!info] Résumé\` (1-2 phrases) / \`## Contexte\` / \`## Détails\` / \`## Points clés\` (3-5 bullets) / \`## Concepts liés\` (LISTE de wikilinks contextualisés, **obligatoire**) / \`## Sources\`.
4. Longueur : 200-1500 mots.
5. **WIKILINKS CROISÉS — NON-NÉGOCIABLE** :
   - **Minimum 3 wikilinks sortants \`[[nom-page]]\`** dans chaque article, dès que la KB contient ≥2 autres pages. Inline au fil du texte, pas seulement dans la section \`## Concepts liés\`.
   - Format \`[[nom-page]]\` sans extension, sans chemin. Exemple : \`pagemark\` pour cibler \`concepts/pagemark.md\`.
   - Quand tu cites un concept, une personne ou un outil qui a déjà une page wiki, **utilise toujours \`[[...]]\`** même en cours de phrase.
   - Quand un concept émerge et qu'il MÉRITE sa propre page, crée-la dans la même opération et référence-la via \`[[...]]\`.
   - Le champ YAML \`liens_forts\` reprend les 2-4 wikilinks les plus importants de l'article.
6. **PRÉFÈRE update à create.** Un article existant + nouveau raw → update le frontmatter (sources, modifié) et enrichis le contenu. Ne duplique pas.
7. **Contradictions** entre raw et article existant : NE PAS écraser. Marque \`statut: to-verify\` + section \`## Notes\` avec les deux versions.
8. Met à jour \`wiki/index.md\` : 1 ligne par article \`| titre | type | importance | résumé 1 ligne |\`.
9. Ajoute une entrée \`log.md\` résumant l'opération.
10. **Corrections ciblées** : si le prompt utilisateur inclut une section \`## Corrections ciblées détectées par l'auditeur\`, tu dois AUSSI tenter de résoudre ces issues PENDANT cette compilation.
   - Pour chaque \`broken-ref\` : retrouve la cible probable parmi les articles existants (match par kebab-case approximatif, synonyme, ou pluriel/singulier) et émets un \`update\` de la page source pour corriger le \`[[wikilink]]\`. Si AUCUNE cible évidente → ignore l'issue.
   - Pour chaque \`orphan-source\` : émets un \`update\` de la page avec le frontmatter allégé (ligne \`sources:\` mise à jour, sans l'entrée fantôme). Le corps de l'article reste intact.
   - **Interdit** : \`rename\` / \`delete\` sur la base d'une issue de lint. Reste conservateur — si ambigu, ignore l'issue et elle reviendra au run suivant.
   - Ces corrections peuvent s'ajouter aux \`operations[]\` produites pour les raw à compiler. Mentionne-les brièvement dans le champ \`reason\` de chaque op (\`"fix broken-ref: [[xxx]] → [[yyy]]"\`).

## Exemple de wikilinks bien faits

❌ Mauvais : "Le projet utilise React et Supabase. Il est mobile-first."

✓ Bon : "Le projet [[pagemark]] utilise [[react-native-stack]] et [[supabase]] comme backend. Son positionnement est détaillé dans [[pagemark-angle-editorial]]."

## Format de sortie — JSON strict

Retourne UNIQUEMENT un JSON valide (pas de markdown fence, pas de préambule) :

\`\`\`json
{
  "operations": [
    {
      "op": "create" | "update" | "rename",
      "filename": "concepts/pagemark.md",
      "content": "contenu markdown complet avec frontmatter YAML en tête",
      "reason": "pourquoi cette opération — audit trail court"
    }
  ],
  "indexUpdate": "contenu complet du nouveau index.md (vit dans wiki/index.md)",
  "logEntry": "## [ISO8601] wiki-build | résumé une ligne"
}
\`\`\`

Note bien : \`filename\` = **chemin relatif au dossier wiki/** (ex: \`concepts/xxx.md\`, \`connections/yyy.md\`). Pas de prefix \`wiki/\`.

Si une source raw/ est ambiguë, crée une page \`statut: to-verify\` plutôt que d'inventer. Si aucune opération n'est nécessaire (tous les raw déjà compilés sans nouveauté), retourne \`{"operations":[],"indexUpdate":"<index inchangé>","logEntry":"## [ISO8601] wiki-build | no-op"}\`.`

const LINT_CONTRADICTION_PROMPT = `Tu es l'agent Lint de BlowWorks. Tu audites la cohérence factuelle d'un wiki markdown.

Tâche : détecter UNIQUEMENT les contradictions ou incohérences entre pages. Pas les problèmes structurels (orphelins, liens brisés…) qui sont couverts par des checks déterministes en amont.

Règles de sortie STRICTES :
- Pour chaque problème, produis EXACTEMENT une ligne de ce format :
    \`CONTRADICTION: wiki/fichierA vs wiki/fichierB - description\`
    ou
    \`INCONSISTENCY: wiki/fichier - description\`
- Pas de préambule, pas de markdown fence, pas d'explication avant ou après.
- Si aucun problème détecté, output EXACTEMENT : \`NO_ISSUES\`

Cherche :
- Dates, noms, chiffres qui ne concordent pas entre deux pages
- Recommandations ou décisions opposées sur le même sujet
- Statuts divergents (page A dit X "verified", page B dit X "débunké")

IGNORE :
- Différences de ton, de niveau de détail, de structure
- Pages \`statut: to-verify\` qui ont déjà été flaggées ailleurs
- Opinions vs faits
- Concepts voisins mais distincts`

const RESEARCHER_PROMPT_V1 = `Tu es l'agent Researcher de BlowWorks — fact-checker automatique.

Tu reçois en phase 2 le wiki intégral + les résultats de N recherches web (Tavily). Tu dois produire des \`operations\` de type \`update\` UNIQUEMENT quand les sources web contredisent ou précisent l'info actuelle.

## Règles

- \`op\` toujours \`"update"\` — un researcher n'altère ni la structure (pas de rename/delete) ni ne crée de pages (pas de create).
- \`filename\` relatif à wiki/ (ex: \`concepts/next-js.md\`).
- \`content\` = page COMPLÈTE mise à jour (frontmatter + corps), pas un diff.
- Frontmatter :
  - \`statut: verified\` si l'info est désormais confirmée par une source fiable.
  - \`modifié: <date ISO du jour>\`
  - \`sources\` : ajoute les URLs consultées, garde les sources existantes.
- Corps : mentionne l'info mise à jour avec citation courte "(source: domaine, vérifié YYYY-MM-DD)".
- Si une recherche n'apporte rien de concluant → ne touche pas à la page.
- Conserve style et ton existants — tu es FACT-CHECKER, pas rewriter.

## Format de sortie — JSON strict (pas de markdown fence, pas de préambule)
{
  "operations": [
    { "op": "update", "filename": "concepts/next-js.md", "content": "<page complète>", "reason": "version 15 confirmée via vercel.com" }
  ],
  "logEntry": "## [ISO8601] researcher | N pages actualisées via M recherches"
}

Si aucune page ne mérite d'être actualisée : \`{"operations":[],"logEntry":"..."}\`.`

// Seed des deux agents système obligatoires. Idempotent : n'insère que si
// la ligne correspondante n'existe pas encore (clé primaire fixe pour les
// agents système). Puis `upgradeSystemPromptsIfNeeded` applique les
// dernières versions de prompts pour les installs antérieures.
function seedSystemAgents(db: Database.Database): void {
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO agents (id, kind, name, description, model, system_prompt,
                         temperature, max_tokens, enabled, created_at, updated_at)
    VALUES (@id, @kind, @name, @description, @model, @system_prompt,
            @temperature, @max_tokens, @enabled, @created_at, @updated_at)
    ON CONFLICT(id) DO NOTHING
  `)

  insert.run({
    id: 'agent.synthesizer',
    kind: 'synthesizer',
    name: 'Synthétiseur',
    description:
      'Condense une conversation en une synthèse structurée pour la mémoire long-terme. Répond FLUSH_OK si rien ne vaut d\'être sauvé.',
    model: 'anthropic/claude-sonnet-4-6',
    system_prompt: SYNTHESIZER_PROMPT_V2,
    // Température basse : on veut une synthèse stable et factuelle,
    // pas une réécriture créative de la conversation.
    temperature: 0.3,
    // Synthèse courte : 4096 tokens (était 2048) — laisse plus d'air pour
    // les longues conversations. Toujours conservateur côté facture.
    max_tokens: 4096,
    enabled: 1,
    created_at: now,
    updated_at: now
  })

  insert.run({
    id: 'agent.wiki_builder',
    kind: 'wiki_builder',
    name: 'Wiki Builder',
    description:
      'Compile les synthèses brutes raw/ en pages wiki structurées avec frontmatter YAML, wikilinks croisés, index et log maintenus.',
    model: 'anthropic/claude-sonnet-4-6',
    system_prompt: WIKI_BUILDER_PROMPT_V2,
    // Température très basse : le Wiki Builder doit produire du JSON
    // strictement valide + des pages cohérentes avec l'existant — pas
    // de place pour de la créativité qui casserait la structure.
    temperature: 0.2,
    // Gros budget : JSON d'opérations avec N pages complètes + index + log.
    // 24 576 (était 16 384) — combiné au chunking par batch de 3 raw du
    // runner, évite les troncatures observées sur les imports volumineux
    // (romans, longs articles). Passe à 32 768 manuellement si tu as un
    // modèle qui le supporte (Claude Opus, GPT-4 Turbo).
    max_tokens: 24576,
    enabled: 1,
    created_at: now,
    updated_at: now
  })

  insert.run({
    id: 'agent.lint',
    kind: 'lint',
    name: 'Lint',
    description:
      'Audit de cohérence du wiki : orphelins, liens brisés, concepts fantômes, pages périmées + détection de contradictions factuelles via LLM.',
    model: 'anthropic/claude-sonnet-4-6',
    system_prompt: LINT_CONTRADICTION_PROMPT,
    // 0.1 : déterminisme maximal pour la sortie machine-parseable
    // (NO_ISSUES / CONTRADICTION: / INCONSISTENCY:).
    temperature: 0.1,
    // 4096 : les rapports de contradictions sont courts (quelques
    // lignes par issue). Si le wiki devient énorme (>100 pages),
    // l'utilisateur peut augmenter à 8192 via Settings > Agents.
    max_tokens: 4096,
    enabled: 1,
    created_at: now,
    updated_at: now
  })

  insert.run({
    id: 'agent.researcher',
    kind: 'researcher',
    name: 'Researcher',
    description:
      "Actualise le wiki via recherches web (Tavily). Identifie les versions/dates/prix obsolètes, vérifie auprès des sources et met à jour les pages + frontmatter.sources. Désactivé par défaut (coût API).",
    // Haiku 4.5 : suffit pour la tâche de fact-checking + bien moins cher
    // que Sonnet (~10×). L'utilisateur peut switcher vers Sonnet dans
    // Settings > Agents si la qualité des résultats n'est pas suffisante.
    model: 'anthropic/claude-haiku-4-5-20251001',
    system_prompt: RESEARCHER_PROMPT_V1,
    // 0.2 : factual, limite la créativité dans la réécriture des pages.
    temperature: 0.2,
    // 16384 : phase 2 produit des pages complètes pour plusieurs updates
    // à la fois. Plus large que lint mais moins que wiki_builder (qui
    // crée potentiellement tout le wiki d'un coup).
    max_tokens: 16384,
    // DÉSACTIVÉ par défaut — le researcher coûte 2 appels LLM + N appels
    // Tavily par run. L'utilisateur active sciemment dans Settings →
    // Agents une fois la clé Tavily configurée.
    enabled: 0,
    created_at: now,
    updated_at: now
  })

  upgradeSystemPromptsIfNeeded(db, now)
}

// Migration one-shot : force la mise à jour des prompts système si la
// version installée est inférieure à SYSTEM_PROMPTS_VERSION. Sprint 4 :
// respecte désormais le flag `customized` — n'écrase un agent QUE si
// l'utilisateur ne l'a jamais édité (customized=0). Protège les tunings
// utilisateur aux futurs bumps de prompts système.
function upgradeSystemPromptsIfNeeded(db: Database.Database, now: number): void {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('agents.promptsVersion') as
    | { value: string }
    | undefined
  const installed = row ? parseInt(row.value, 10) : 0
  if (installed >= SYSTEM_PROMPTS_VERSION) return

  // `WHERE customized = 0` : skip les agents édités à la main par l'user.
  const update = db.prepare(
    `UPDATE agents SET system_prompt = ?, updated_at = ? WHERE id = ? AND customized = 0`
  )
  update.run(SYNTHESIZER_PROMPT_V2, now, 'agent.synthesizer')
  update.run(WIKI_BUILDER_PROMPT_V2, now, 'agent.wiki_builder')
  update.run(LINT_CONTRADICTION_PROMPT, now, 'agent.lint')
  update.run(RESEARCHER_PROMPT_V1, now, 'agent.researcher')

  const updateTuning = db.prepare(
    `UPDATE agents SET temperature = ?, max_tokens = ?, updated_at = ? WHERE id = ? AND customized = 0`
  )
  updateTuning.run(0.3, 4096, now, 'agent.synthesizer')
  updateTuning.run(0.2, 24576, now, 'agent.wiki_builder')
  updateTuning.run(0.2, 16384, now, 'agent.researcher')

  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('agents.promptsVersion', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SYSTEM_PROMPTS_VERSION))
}
