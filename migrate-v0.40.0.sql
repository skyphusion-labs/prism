-- v0.40.0 migration delta ONLY. Adds the `mode` column to the renders
-- table so a row can be marked as either 'full' (the existing train +
-- keyframes + I2V + assemble pipeline) or 'keyframes-only' (the new
-- preview pass landing in v0.40.0: train + SDXL keyframes only, no Wan
-- motion, no silent-MP4 assembly). Rows pre-dating this migration stay
-- NULL and the read path treats NULL as 'full' for backward compat.
--
-- Idempotent caveat: SQLite's ALTER TABLE ADD COLUMN is NOT idempotent;
-- re-running this against an already-migrated DB surfaces "duplicate
-- column name" which wrangler d1 execute treats as a non-fatal warning
-- and continues past. Same pattern as the v0.36.0 + v0.39.0 ALTERs.
--
-- Apply: wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.40.0.sql

ALTER TABLE renders ADD COLUMN mode TEXT;
