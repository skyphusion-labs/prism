-- v0.46.0 migration: persisted cast manager.
--
-- Applied to prod via:
--   npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.46.0-cast.sql
--
-- See schema.sql for the canonical state-after; this file is the delta
-- only. Future migrations follow the same `migrations/vX.Y.Z-name.sql`
-- pattern (delta-only, never re-execute schema.sql against prod). The
-- CREATE TABLE / CREATE INDEX statements below are idempotent (IF NOT
-- EXISTS), so a re-apply is a safe no-op.

CREATE TABLE IF NOT EXISTS cast_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT NOT NULL,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  bible           TEXT,
  portrait_key    TEXT,
  portrait_mime   TEXT,
  ref_keys_json   TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cast_user
  ON cast_members(user_email, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cast_slug_user
  ON cast_members(user_email, slug);
