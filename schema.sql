-- Chat history. One row per call to /api/chat.
--
-- user_email is set from the Cf-Access-Authenticated-User-Email header
-- injected by Cloudflare Access; local dev defaults to 'anonymous'.
--
-- model_type is 'chat' | 'image' | 'tts' | 'video'. Drives output rendering
-- on the client and dispatch logic on the server.
--
-- For model_type='video', the row is created with status='pending' and a
-- job_id pointing at the upstream provider's operation. The frontend polls
-- /api/job/:id, which advances the row to 'done' (downloading the bytes
-- into R2 + recording the output_artifact) or 'failed' (recording the error
-- in job_error).
--
-- output holds text for chat models, '' for image/tts/video.
-- output_artifact is JSON { key, mime, type } pointing to an R2 object for
-- non-text outputs (generated images, generated audio, generated video).
--
-- attachments is a JSON array as documented in the worker; audio attachments
-- store only the transcript, the raw audio is dropped.

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
  retrieved_context TEXT
);

CREATE INDEX IF NOT EXISTS idx_chats_user_created
  ON chats(user_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_pending
  ON chats(status, user_email) WHERE status = 'pending';

-- ---------- RAG: documents and chunks ----------
--
-- A document is one user-uploaded file (.txt or .md). Its raw bytes live
-- in R2 under the in/ prefix; this row tracks metadata. A document is
-- chunked at upload time and each chunk gets embedded and stored in
-- Vectorize. chunk rows link D1 text to Vectorize vector IDs so we can
-- do vector -> text lookups at retrieval time.
--
-- D1 doesn't honor PRAGMA foreign_keys, so the FK relationship below is
-- documentation only; the application code handles cascade-on-delete.

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
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc    ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vector ON chunks(vector_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user   ON chunks(user_email);
