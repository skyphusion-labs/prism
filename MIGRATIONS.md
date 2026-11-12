# Migrating an existing deployment

This is the per-version upgrade runbook for an existing deployment. For a fresh
install use `schema.sql` (see the README). Apply the deltas below in order, then
redeploy.

**CI auto-apply (v0.164.3+).** Production deploys on `main` run `wrangler d1 migrations apply skyphusion-llm --remote` before `wrangler deploy` (see `.github/workflows/ci.yml`). Pending migrations live in `migrations/`; wrangler tracks applied files in the D1 `d1_migrations` table. Additive migrations (`CREATE TABLE IF NOT EXISTS`, etc.) ship with zero friction. The legacy per-release `migrate-vX.Y.Z.sql` files below remain for historical reference and for operators upgrading across ancient versions manually; new schema changes should add a numbered file under `migrations/` instead.

**Migration philosophy (read this first).** `schema.sql` is the canonical full schema for standing up a *fresh* database. It contains non-idempotent `ALTER TABLE` statements, so re-running it against a database that already has tables will raise `SQLITE_ERROR: duplicate column name` and, because `wrangler d1 execute --file` runs the whole file as one transaction, abort and roll back the entire run. **Never re-run `schema.sql` against an existing database.** To upgrade an existing deployment, apply only the delta for each version you're crossing, using the explicit commands below (or, for releases that ship one, the per-release `migrate-vX.Y.Z.sql` delta file). Apply each version's delta in order, then redeploy.

**v1.1.0 (account-scoped BYOK): BREAKING for existing BYOK users, no DDL.** `account_id` is a new key in the existing `user_prefs.prefs_json` blob. Every public-mode user saved before v1.1.0 (slug + token only) is refused with HTTP 412 `gateway_account_id_required` on every inference route until they add their 32-hex Cloudflare account ID under Account > AI Gateway, and their token must hold Workers AI Read as well as AI Gateway Run. A user who upgrades and does nothing loses inference. Tell your users before you tag. Access-mode installs using worker secrets are unaffected.

v0.13.0 onward touched the D1 schema only at v0.20.0, v0.20.2, and v0.20.3; everything else in the v0.13.0 to v0.20.0 range is code-only. The pre-v0.13.0 migrations (v0.7.0 to v0.10.0) are below for anyone upgrading from very old deployments.

For v0.7.0 (video generation):

```
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN status TEXT NOT NULL DEFAULT 'done'"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_id TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_provider TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_error TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_started_at TEXT"
```

For v0.8.0 (RAG Pass 1):

```
npx wrangler vectorize create skyphusion-llm-vec --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index skyphusion-llm-vec --property-name=user_email --type=string
# Create the documents and chunks tables explicitly. (Historically this step
# was "--file=schema.sql"; that is no longer safe because today's schema.sql
# also carries later non-idempotent ALTERs. Use the explicit DDL below.)
npx wrangler d1 execute skyphusion-llm --remote --command "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), filename TEXT NOT NULL, mime TEXT NOT NULL, r2_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, total_chars INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0)"
npx wrangler d1 execute skyphusion-llm --remote --command "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, user_email TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, vector_id TEXT NOT NULL, FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE)"
```

For v0.8.1 (RAG Pass 2):

```
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN retrieved_context TEXT"
```

For v0.8.2 (Phase 3A, RAG over PDF + XLSX):

```
npm install
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chunks ADD COLUMN page INTEGER"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chunks ADD COLUMN sheet TEXT"
```

For v0.10.0 (multi-turn conversations):

```
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN conversation_id TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN turn_index INTEGER"
npx wrangler d1 execute skyphusion-llm --remote --command "UPDATE chats SET conversation_id = 'legacy-' || id, turn_index = 0 WHERE conversation_id IS NULL"
npx wrangler d1 execute skyphusion-llm --remote --command "CREATE INDEX IF NOT EXISTS idx_chats_conversation ON chats(conversation_id, turn_index)"
```

For v0.12.0 (wrangler.toml restructure): see the CHANGELOG entry for the exact `[[workflows]]` and `[observability]` blocks to paste into your local `wrangler.toml`, plus the `GATEWAY_ID` move from `[vars]` to a worker secret.

For v0.14.0 (BYOK removal of OpenAI and Google): drop the now-unused secrets if you want a clean state:

```
npx wrangler secret delete OPENAI_API_KEY
npx wrangler secret delete GOOGLE_API_KEY
```

Neither is fatal if left in place; they're just inert.

v0.13.0, v0.15.0, v0.16.0, v0.17.0: no D1 migrations. v0.17.0 adds an optional `TAVILY_API_KEY` secret for the web-search feature; skip it and the feature falls back to Wikipedia only.

v0.18.x, v0.19.x: code-only (provider extractions, SSE refactors, chunker rewrite). No D1 migrations.

For v0.20.0 (projects and knowledge stores): ships the delta file `migrate-v0.20.0.sql`, which adds the `projects` and `project_documents` tables and their indexes. Every statement is `CREATE ... IF NOT EXISTS`, so this one is safely re-runnable, but apply it once:

```
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.20.0.sql
```

v0.20.1, v0.20.1.1: frontend-only (projects UI, modal hotfix). No D1 migrations.

For v0.20.2 (conversation to project association): ships the delta file `migrate-v0.20.2.sql`, which adds `chats.project_id` and a partial index. The `ALTER` is non-idempotent; run the file exactly once. If you have already added this column, skip it (re-running raises "duplicate column name" and rolls back the run).

v0.21.x, v0.22.0: code/frontend only, no D1 migrations.

For v0.22.1 (transparent image gen): no D1 migration. Re-introduces an OPTIONAL `OPENAI_API_KEY` secret, used only for `openai/gpt-image-1.5` transparent output via a direct OpenAI call (chat is unaffected and still rides Unified Billing). If you ran the v0.14.0 cleanup that deleted this secret, re-add it to enable transparency; skip it and gpt-image-1.5 stays opaque through the proxy:

```
npx wrangler secret put OPENAI_API_KEY
```

For v0.20.3 (Discord ingestion): this release ships a delta file, `migrate-v0.20.3.sql`, containing the `project_messages` table and the four new `chunks` columns. Apply it once:

```
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.20.3.sql
```

The `ALTER TABLE chunks ADD COLUMN` statements in it are non-idempotent; run the file exactly once. If you need to verify what applied, `PRAGMA table_info(chunks)` should list `channel`, `authors`, `sent_at_start`, `sent_at_end`.

v0.20.4: frontend-only (Discord import button). No D1 migration.

## Releases from v0.21.0 on

The entries above predate the `migrate-vX.Y.Z.sql` convention. From v0.21.0 onward,
these are the releases that shipped a D1 delta file; apply each once, in order:

For v0.34.0 (render history): `migrate-v0.34.0.sql` adds the `renders` table and its
indexes. All `CREATE ... IF NOT EXISTS`, so it is safely re-runnable.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.34.0.sql
```

For v0.36.0 (render labels): `migrate-v0.36.0.sql` adds `renders.label`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.36.0.sql
```

For v0.39.0 (keyframe history): `migrate-v0.39.0.sql` adds `renders.keyframes_json`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.39.0.sql
```

For v0.40.0 (render mode): `migrate-v0.40.0.sql` adds `renders.mode`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.40.0.sql
```

For v0.42.0 (per-shot locks): `migrate-v0.42.0.sql` adds `renders.locked_shots_json`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.42.0.sql
```

For v0.122.0 (off-GPU video finish): `migrate-v0.122.0.sql` adds `renders.finish_state`,
the finish idempotency lock.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.122.0.sql
```

For v0.126.0 (render-history folders + tags): `migrate-v0.126.0.sql` adds
`renders.folder_path` + `renders.tags_json` and the `renders_by_user_folder` index.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.126.0.sql
```

For v0.164.0 (public demo AI Gateway prefs): `migrate-v0.164.0.sql` adds the
`user_prefs` table for per-user gateway slug + CF API token storage.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.164.0.sql
```

**Cast manager + storyboard projects (`migrations/` subdirectory).** Starting at
v0.46.0 the delta files moved from the repo root (`migrate-vX.Y.Z.sql`) into a
`migrations/` subdirectory (`migrations/vX.Y.Z-name.sql`); the delta-only convention is
unchanged (never re-run `schema.sql` against prod). Apply each once, in order, if you
are upgrading across these versions:

For v0.46.0 (persisted cast manager): `migrations/v0.46.0-cast.sql` adds the
`cast_members` table and its indexes (idempotent, `IF NOT EXISTS`).

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.46.0-cast.sql
```

For v0.53.0 (persisted storyboard projects): `migrations/v0.53.0-projects.sql` adds the
`storyboard_projects` table and its indexes (idempotent, `IF NOT EXISTS`).

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.53.0-projects.sql
```

For v0.55.0 (project-scoped render history): `migrations/v0.55.0-renders-project-id.sql`
adds `renders.project_id` and the `renders_by_user_project` index.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.55.0-renders-project-id.sql
```

For v0.57.0 (standalone cast LoRA training): `migrations/v0.57.0-cast-lora.sql` adds the
five LoRA columns to `cast_members` (`lora_key`, `lora_status`, `lora_job_id`,
`lora_error`, `lora_trained_at`).

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.57.0-cast-lora.sql
```

The v0.55.0 and v0.57.0 files use `ALTER TABLE ADD COLUMN`, which SQLite does not make
idempotent; re-applying surfaces a non-fatal "duplicate column name" warning per
statement and continues. Fresh installs get all of the above from `schema.sql` and need
none of these deltas.

All other releases are code/frontend-only with no D1 migration.

## Vectorize metadata filter for RAG retrieval (fleet-chezmoi#1636)

**Why.** Retrieval used to query Vectorize globally and scope by user only in the D1 join. On a shared
index, a user with a small share of the vectors can get a top-K made entirely of other users' vectors,
which the join then drops, so they see no results even when their own documents match.
`VEC_METADATA_FILTER = "on"` filters the Vectorize query on `user_email` as well. The D1 join stays,
as the second layer of scope.

**It is off by default, and the order matters.** A Vectorize metadata index is not retroactive. Turn
the filter on before the backfill, and every vector written before the index existed is invisible to it:
retrieval returns nothing.

1. Create the metadata index (once):

   ```bash
   npx wrangler vectorize create-metadata-index skyphusion-llm-vec --property-name=user_email --type=string
   ```

   Vectors upserted from now on are indexed automatically.

2. If the index already holds vectors, re-upsert them. The script reads every id from D1
   `chunks.vector_id`, fetches each vector, and writes it back with the same id, values and metadata.
   Nothing is re-embedded. It refuses to run until step 1 is done, prints counts only (never an id or a
   value), and is safe to re-run.

   ```bash
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
     node scripts/vectorize-backfill-metadata.mjs --index skyphusion-llm-vec --d1 <D1 database uuid> --dry-run
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
     node scripts/vectorize-backfill-metadata.mjs --index skyphusion-llm-vec --d1 <D1 database uuid>
   ```

   The token needs Vectorize Edit and D1 Read. Exit 0 means every D1 id was re-upserted. Exit 1 means
   some ids had no vector (`gaps`) or no `user_email` metadata (`missing_metadata`); do not turn the
   filter on until that is understood. Exit 2 means it refused or could not read, and nothing was written.

3. Verify, then set `VEC_METADATA_FILTER = "on"` (a plain var) and deploy. Check that a user with
   documents still gets results, and that the index `info` vector count matches the script's `upserted`
   count. Allow a few seconds after the upsert for Vectorize to apply it.

A fresh deployment that creates the metadata index before its first upload needs only step 1, then the
var.

**Caveat:** a string metadata index matches on the first 64 bytes of the value. Public-mode identities
(`usr_` plus 24 hex characters) are well inside that. In access mode, two emails sharing their first 64
bytes would share an index entry. The D1 join still scopes their results correctly, so the worst case
for those users is the old global behaviour, not a disclosure.


## Vector ids without identity (prism#232)

**Why.** Before prism#232, ingest minted each Vectorize vector id as `<identity>:<document id>:<chunk
index>`. In access mode the identity is the raw email address, so every id in the index carried it.
Vector ids are visible outside D1: in the index, in query results, and in any tool that lists or
exports ids. New ingests mint a random id (`c_` plus 32 hex digits, `src/vector-id.ts`). Ownership
stays in the vector's `user_email` metadata and the D1 `chunks` row.

**Nothing breaks if you do nothing.** Every reader (retrieval, document delete, account delete) looks
ids up through D1 `chunks.vector_id`, so old ids keep working next to new ones. Public-mode ids carry
the opaque `usr_` id, not an email, and are left alone.

**To remove the emails from existing ids** (access-mode deployments only), re-key them. The script
selects the D1 rows whose `vector_id` contains `@`, writes each vector under a new random id with the
same values and metadata (nothing is re-embedded), points the D1 row at the new id, then deletes the old
id. It prints counts only, never an id or a value, and is safe to re-run.

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  node scripts/vectorize-rekey-vector-ids.mjs --index skyphusion-llm-vec --d1 <D1 database uuid> --dry-run
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  node scripts/vectorize-rekey-vector-ids.mjs --index skyphusion-llm-vec --d1 <D1 database uuid>
```

The token needs Vectorize Edit and D1 Edit. `legacy` in the dry-run output is the number of
email-bearing ids. Exit 0 means every one was re-keyed. Exit 1 means some D1 ids had no vector (`gaps`)
or a row changed during the run (`conflicts`). Exit 2 means it refused or could not read. Vectorize
applies writes asynchronously, so retrieval for a re-keyed chunk can miss for a few seconds after its
batch; run it in a quiet window.
