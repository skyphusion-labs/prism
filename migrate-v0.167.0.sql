-- Migration v0.167.0 (issue #80): first-party auth plane.
--
-- Adds the three tables the public-deployment auth core needs. Ownership
-- columns on existing tables (chats.user_email, documents.user_email, etc.) are
-- NOT renamed: in public mode they simply hold the opaque users.id string
-- instead of an Access email, so no data migration touches existing rows.
--
-- Apply to an existing DB with:
--   npx wrangler d1 execute skyphusion-llm --remote --file=./migrate-v0.167.0.sql
-- These are all CREATE TABLE / INDEX IF NOT EXISTS, so re-applying is a no-op.

-- Accounts. id is the opaque stable ownership key ("usr_" + 24 hex). username_lc
-- is the case-insensitive uniqueness key. password_hash is a PHC-style PBKDF2
-- string (see src/auth-kdf.ts). email is reserved for forward-compat (recovery)
-- and is not written by the v0.167.0 signup route.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  username_lc   TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions. token_hash is SHA-256(raw token) hex; the raw token lives only in
-- the httpOnly cookie, never in D1. Rows are dropped on logout, expiry, and
-- account deletion for instant server-side revocation.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Signup/login rate-limit counters. bucket_key is e.g. "login:<ip>:<username>"
-- or "signup:<ip>"; count is the attempts in the current fixed window that
-- began at window_start. See src/rate-limit.ts.
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket_key   TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
