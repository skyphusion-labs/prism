-- v0.57.0 migration: standalone LoRA training fields on cast_members.
--
-- Applied to prod via:
--   npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.57.0-cast-lora.sql
--
-- SQLite ALTER TABLE ADD COLUMN is not idempotent in the IF NOT EXISTS
-- sense; re-applying surfaces "duplicate column name" per-statement,
-- which wrangler d1 execute treats as a non-fatal warning and continues
-- past.

ALTER TABLE cast_members ADD COLUMN lora_key TEXT;
ALTER TABLE cast_members ADD COLUMN lora_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE cast_members ADD COLUMN lora_job_id TEXT;
ALTER TABLE cast_members ADD COLUMN lora_error TEXT;
ALTER TABLE cast_members ADD COLUMN lora_trained_at TEXT;
