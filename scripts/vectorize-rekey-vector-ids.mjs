#!/usr/bin/env node
// Re-key existing RAG vectors whose id embeds an email address (prism#232).
//
// WHY. Before prism#232, access-mode ingest minted vector ids as `${userEmail}:${docId}:${chunkIndex}`,
// so the raw email sat in every id in the Vectorize index. New ingests mint a random id
// (src/vector-id.ts). This script moves the OLD vectors to random ids. Nothing is re-embedded: the
// same values and metadata are written under the new id.
//
// WHICH IDS. Only ids that contain "@" (the access-mode email form). Public-mode ids carry the opaque
// `usr_` id and are left alone. The source of truth is D1 `chunks.vector_id`.
//
// ORDER PER BATCH (add before remove):
//   1. read the old vectors (get_by_ids)
//   2. upsert each one under a fresh random id
//   3. point the D1 row at the new id (UPDATE ... WHERE id = ? AND vector_id = <old>)
//   4. delete the old ids
// A crash after step 2 leaves an unreferenced new vector (harmless: retrieval joins through D1, so it
// is never returned). A crash after step 3 leaves the old vector until a re-run, which finds nothing
// left to move for that row; delete it by hand from the printed counts if it matters. A D1 row that
// changed under us (step 3 updates 0 rows) has its new vector deleted and is counted as a conflict.
//
// Vectorize applies mutations asynchronously, so for a few seconds after a batch a query can still
// return an old id that D1 no longer has. Retrieval for those chunks misses until the index catches
// up. Run it in a quiet window.
//
// PRIVACY: this script never prints an id, a value, or a metadata value. It prints counts only.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/vectorize-rekey-vector-ids.mjs --index skyphusion-llm-vec --d1 <database uuid> [--dry-run] [--batch 20]
// Token needs Vectorize Edit and D1 Edit on the account.
// Exit: 0 every legacy id re-keyed (or none found); 1 gaps or conflicts (counts printed);
// 2 refused or could not measure.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

/** Same format as src/vector-id.ts mintVectorId (a test keeps the two in step). */
export function mintVectorId() {
  return "c_" + randomUUID().replace(/-/g, "");
}

/** True for a legacy id that carries an email address. */
export function isEmailBearingId(id) {
  return typeof id === "string" && id.includes("@");
}

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
  async function d1(db, sql, params = []) {
    const r = await call(`/d1/database/${encodeURIComponent(db)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const first = Array.isArray(r) ? r[0] : null;
    if (!first || !Array.isArray(first.results)) throw new Error("D1 query returned no result set");
    return first;
  }
  const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ix = (index) => `/vectorize/v2/indexes/${encodeURIComponent(index)}`;
  return {
    async census(db) {
      const r = await d1(db, "SELECT COUNT(*) AS total, COALESCE(SUM(instr(vector_id, '@') > 0), 0) AS legacy FROM chunks");
      const row = r.results[0] ?? {};
      return { total: Number(row.total ?? 0), legacy: Number(row.legacy ?? 0) };
    },
    async legacyRows(db) {
      const r = await d1(db, "SELECT id, vector_id FROM chunks WHERE instr(vector_id, '@') > 0 ORDER BY id");
      return r.results.map((row) => ({ rowId: Number(row.id), vectorId: String(row.vector_id) }));
    },
    async repoint(db, rowId, oldId, newId) {
      const r = await d1(db, "UPDATE chunks SET vector_id = ? WHERE id = ? AND vector_id = ?", [newId, rowId, oldId]);
      return Number(r.meta?.changes ?? 0);
    },
    async getByIds(index, ids) {
      const r = await call(`${ix(index)}/get_by_ids`, json({ ids }));
      return Array.isArray(r) ? r : [];
    },
    async upsert(index, vectors) {
      await call(`${ix(index)}/upsert`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: vectors.map((v) => JSON.stringify(v)).join("\n"),
      });
    },
    async deleteByIds(index, ids) {
      await call(`${ix(index)}/delete_by_ids`, json({ ids }));
    },
  };
}

/**
 * The re-key. Returns { code, counts, refusal }. Never logs an id, value or metadata value.
 * code: 0 complete, 1 gaps or conflicts, 2 refused or could not measure.
 */
export async function rekey(api, opts) {
  const counts = { d1_total: 0, legacy: 0, fetched: 0, rekeyed: 0, old_deleted: 0, gaps: 0, conflicts: 0 };
  const mint = opts.mint ?? mintVectorId;
  try {
    const c = await api.census(opts.d1);
    counts.d1_total = c.total;
  } catch (e) {
    return { code: 2, counts, refusal: `could not count D1 chunks: ${e.message}` };
  }
  let rows;
  try {
    rows = (await api.legacyRows(opts.d1)).filter((r) => isEmailBearingId(r.vectorId));
  } catch (e) {
    return { code: 2, counts, refusal: `could not read legacy ids from D1: ${e.message}` };
  }
  counts.legacy = rows.length;
  for (let i = 0; i < rows.length; i += opts.batch) {
    const want = rows.slice(i, i + opts.batch);
    const at = `batch ${i / opts.batch}`;
    let got;
    try {
      got = await api.getByIds(opts.index, want.map((r) => r.vectorId));
    } catch (e) {
      return { code: 2, counts, refusal: `get_by_ids failed at ${at}: ${e.message}` };
    }
    const byId = new Map(got.filter((v) => v && typeof v.id === "string").map((v) => [v.id, v]));
    const moves = [];
    for (const row of want) {
      const v = byId.get(row.vectorId);
      if (!v || !Array.isArray(v.values)) {
        counts.gaps++;
        continue;
      }
      counts.fetched++;
      const newId = mint();
      moves.push({
        row,
        newId,
        vec: { id: newId, values: v.values, ...(v.metadata ? { metadata: v.metadata } : {}), ...(v.namespace ? { namespace: v.namespace } : {}) },
      });
    }
    if (opts.dryRun || moves.length === 0) continue;
    try {
      await api.upsert(opts.index, moves.map((m) => m.vec));
    } catch (e) {
      return { code: 2, counts, refusal: `upsert failed at ${at}: ${e.message}` };
    }
    const oldToDelete = [];
    const orphans = [];
    for (const m of moves) {
      let changed;
      try {
        changed = await api.repoint(opts.d1, m.row.rowId, m.row.vectorId, m.newId);
      } catch (e) {
        return { code: 2, counts, refusal: `D1 update failed at ${at}: ${e.message}` };
      }
      if (changed === 1) {
        counts.rekeyed++;
        oldToDelete.push(m.row.vectorId);
      } else {
        counts.conflicts++;
        orphans.push(m.newId);
      }
    }
    try {
      if (orphans.length) await api.deleteByIds(opts.index, orphans);
      if (oldToDelete.length) await api.deleteByIds(opts.index, oldToDelete);
    } catch (e) {
      return { code: 2, counts, refusal: `delete_by_ids failed at ${at}: ${e.message}` };
    }
    counts.old_deleted += oldToDelete.length;
  }
  const code = counts.gaps > 0 || counts.conflicts > 0 ? 1 : 0;
  return { code, counts, refusal: null };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`vectorize-rekey-vector-ids: ${e.message}`);
    process.exit(2);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!token || !accountId) {
    console.error("vectorize-rekey-vector-ids: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    process.exit(2);
  }
  const r = await rekey(client({ token, accountId }), opts);
  console.log(`@event rekey.result ${JSON.stringify({ index: opts.index, dry_run: opts.dryRun, code: r.code, ...r.counts })}`);
  if (r.refusal) console.error(`REFUSED: ${r.refusal}`);
  else if (r.code === 1) console.error("INCOMPLETE: see gaps and conflicts above.");
  else console.error(opts.dryRun ? "DRY RUN complete: nothing was written." : "COMPLETE: every email-bearing id was re-keyed.");
  process.exit(r.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
