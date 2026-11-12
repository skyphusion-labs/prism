#!/usr/bin/env node
// Re-upsert existing RAG vectors so their `user_email` metadata lands in the Vectorize metadata
// index (skyphusion-labs/fleet-chezmoi#1636).
//
// WHY. Vectorize metadata indexes are not retroactive: a vector upserted before the index existed
// is not in it, so a query filtered on `user_email` cannot see it. prism has always written
// `user_email` into each vector's metadata (src/routes/rag.ts ingestDocument); it was never indexed.
// This script writes every existing vector back with the same id, values and metadata, which is the
// only backfill Vectorize offers. Nothing is re-embedded.
//
// ORDER (the safety property):
//   1. wrangler vectorize create-metadata-index <index> --property-name=user_email --type=string
//   2. this script (refuses to run until step 1 is done)
//   3. only then set VEC_METADATA_FILTER=on on the Worker
//
// SOURCE OF TRUTH FOR THE IDS: D1 `chunks.vector_id`, which holds every vector prism wrote. A D1 id
// that Vectorize cannot return is reported as a GAP, never skipped silently.
//
// PRIVACY: vector ids embed the owner's identity (the raw email in access mode). This script never
// prints an id, a value, or a metadata value. It prints counts only.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/vectorize-backfill-metadata.mjs --index skyphusion-llm-vec --d1 <database uuid> [--dry-run] [--batch 20]
// Token needs Vectorize Edit and D1 Read on the account.
// Exit: 0 every D1 id fetched and re-upserted; 1 gaps or vectors without user_email (nothing
// is hidden, counts printed); 2 refused or could not measure (nothing written).

import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
export const PROPERTY = "user_email";

/** Parse argv into options, or throw with the usage problem. */
export function parseArgs(argv) {
  const o = { index: "", d1: "", dryRun: false, batch: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--index") o.index = argv[++i] ?? "";
    else if (a === "--d1") o.d1 = argv[++i] ?? "";
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--batch") o.batch = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.index) throw new Error("--index is required");
  if (!o.d1) throw new Error("--d1 (the D1 database uuid) is required");
  if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 1000) throw new Error("--batch must be 1..1000");
  return o;
}

/** A tiny client over the REST API. `fetchImpl` is the only seam tests replace. */
export function client({ token, accountId, fetchImpl = fetch }) {
  const base = `${API}/accounts/${accountId}`;
  async function call(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${path}: non-JSON response, HTTP ${res.status}`);
    }
    if (!res.ok || body.success === false) throw new Error(`${path}: HTTP ${res.status}`);
    return body.result;
  }
  return {
    async metadataIndexes(index) {
      const r = await call(`/vectorize/v2/indexes/${encodeURIComponent(index)}/metadata_index/list`);
      return Array.isArray(r?.metadataIndexes) ? r.metadataIndexes : [];
    },
    async vectorIds(d1) {
      const r = await call(`/d1/database/${encodeURIComponent(d1)}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT vector_id FROM chunks ORDER BY id" }),
      });
      const rows = Array.isArray(r) && r[0] && Array.isArray(r[0].results) ? r[0].results : null;
      if (!rows) throw new Error("D1 query returned no result set");
      return rows.map((row) => row.vector_id).filter((v) => typeof v === "string" && v.length > 0);
    },
    async getByIds(index, ids) {
      const r = await call(`/vectorize/v2/indexes/${encodeURIComponent(index)}/get_by_ids`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      return Array.isArray(r) ? r : [];
    },
    async upsert(index, vectors) {
      const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
      await call(`/vectorize/v2/indexes/${encodeURIComponent(index)}/upsert`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: ndjson,
      });
    },
  };
}

/** True when the index carries a string metadata index on PROPERTY. */
export function hasUserEmailIndex(indexes) {
  return indexes.some((m) => m && m.propertyName === PROPERTY && String(m.indexType).toLowerCase() === "string");
}

/**
 * The backfill. Returns { code, counts, refusal }. Never logs an id, value or metadata value.
 * code: 0 complete, 1 gaps or missing metadata, 2 refused or could not measure.
 */
export async function backfill(api, opts) {
  const counts = { d1_ids: 0, fetched: 0, missing_metadata: 0, upserted: 0, gaps: 0 };
  let indexes;
  try {
    indexes = await api.metadataIndexes(opts.index);
  } catch (e) {
    return { code: 2, counts, refusal: `could not read the metadata indexes: ${e.message}` };
  }
  if (!hasUserEmailIndex(indexes)) {
    return {
      code: 2,
      counts,
      refusal:
        `no string metadata index on "${PROPERTY}" for ${opts.index}. Create it first: ` +
        `wrangler vectorize create-metadata-index ${opts.index} --property-name=${PROPERTY} --type=string`,
    };
  }
  let ids;
  try {
    ids = await opts.idsFrom(api);
  } catch (e) {
    return { code: 2, counts, refusal: `could not read vector ids from D1: ${e.message}` };
  }
  counts.d1_ids = ids.length;
  for (let i = 0; i < ids.length; i += opts.batch) {
    const want = ids.slice(i, i + opts.batch);
    let got;
    try {
      got = await api.getByIds(opts.index, want);
    } catch (e) {
      return { code: 2, counts, refusal: `get_by_ids failed at batch ${i / opts.batch}: ${e.message}` };
    }
    const byId = new Map(got.filter((v) => v && typeof v.id === "string").map((v) => [v.id, v]));
    const ready = [];
    for (const id of want) {
      const v = byId.get(id);
      if (!v || !Array.isArray(v.values)) {
        counts.gaps++;
        continue;
      }
      counts.fetched++;
      const meta = v.metadata && typeof v.metadata === "object" ? v.metadata : null;
      if (!meta || typeof meta[PROPERTY] !== "string" || meta[PROPERTY].length === 0) {
        // Re-upserting this would index nothing useful; count it so an operator can look.
        counts.missing_metadata++;
        continue;
      }
      ready.push({ id: v.id, values: v.values, metadata: meta, ...(v.namespace ? { namespace: v.namespace } : {}) });
    }
    if (ready.length > 0 && !opts.dryRun) {
      try {
        await api.upsert(opts.index, ready);
      } catch (e) {
        return { code: 2, counts, refusal: `upsert failed at batch ${i / opts.batch}: ${e.message}` };
      }
      counts.upserted += ready.length;
    }
  }
  const code = counts.gaps > 0 || counts.missing_metadata > 0 ? 1 : 0;
  return { code, counts, refusal: null };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`vectorize-backfill-metadata: ${e.message}`);
    process.exit(2);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!token || !accountId) {
    console.error("vectorize-backfill-metadata: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    process.exit(2);
  }
  const api = client({ token, accountId });
  const r = await backfill(api, { ...opts, idsFrom: (a) => a.vectorIds(opts.d1) });
  console.log(`@event backfill.result ${JSON.stringify({ index: opts.index, dry_run: opts.dryRun, code: r.code, ...r.counts })}`);
  if (r.refusal) console.error(`REFUSED: ${r.refusal}`);
  else if (r.code === 1) console.error("INCOMPLETE: see gaps and missing_metadata above. Do not set VEC_METADATA_FILTER=on yet.");
  else console.error(opts.dryRun ? "DRY RUN complete: nothing was written." : "COMPLETE: every D1 id was re-upserted.");
  process.exit(r.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
