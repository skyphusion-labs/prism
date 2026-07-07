-- D1 schema of record for skyphusion-llm (prism playground).
-- Squashed baseline (2026-07-07): replaces the manual migrate-v*.sql delta chain for CI.
-- Apply via: wrangler d1 migrations apply skyphusion-llm --remote
-- Idempotent on existing prod: CREATE TABLE/INDEX use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS chats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  model             TEXT NOT NULL,
  model_type        TEXT NOT NULL DEFAULT 'chat',
  system_prompt     TEXT,
  user_input        TEXT NOT NULL,
  output            TEXT NOT NULL DEFAULT '',
  output_artifact   TEXT,
  attachments       TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  latency_ms        INTEGER,
  ai_gateway_log_id TEXT,
  status            TEXT NOT NULL DEFAULT 'done',
  job_id            TEXT,
  job_provider      TEXT,
  job_error         TEXT,
  job_started_at    TEXT,
  retrieved_context TEXT,
  conversation_id   TEXT,
  turn_index        INTEGER,
  project_id        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chats_conversation
  ON chats(conversation_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_chats_user_created
  ON chats(user_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_pending
  ON chats(status, user_email) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_chats_project
  ON chats(project_id, created_at DESC) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  total_chars     INTEGER NOT NULL DEFAULT 0,
  chunk_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_documents_user_created
  ON documents(user_email, created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     INTEGER NOT NULL,
  user_email      TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  text            TEXT NOT NULL,
  vector_id       TEXT NOT NULL,
  page            INTEGER,
  sheet           TEXT,
  channel         TEXT,
  authors         TEXT,
  sent_at_start   TEXT,
  sent_at_end     TEXT,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc    ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vector ON chunks(vector_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user   ON chunks(user_email);

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT NOT NULL,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_user
  ON projects(user_email, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug_user
  ON projects(user_email, slug);

CREATE TABLE IF NOT EXISTS project_documents (
  project_id      INTEGER NOT NULL,
  document_id     INTEGER NOT NULL,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, document_id),
  FOREIGN KEY (project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_documents_doc
  ON project_documents(document_id);

CREATE TABLE IF NOT EXISTS project_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  document_id   INTEGER NOT NULL,
  user_email    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  channel       TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_id     TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL,
  content       TEXT NOT NULL,
  FOREIGN KEY (project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_messages_proj
  ON project_messages(project_id, sent_at);

CREATE INDEX IF NOT EXISTS idx_project_messages_doc
  ON project_messages(document_id);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_email  TEXT PRIMARY KEY,
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
