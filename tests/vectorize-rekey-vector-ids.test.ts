// scripts/vectorize-rekey-vector-ids.mjs (prism#232): which ids move, the add-before-remove order,
// gaps and conflicts, dry run, refusals, and that no id reaches the printed result.

import { describe, it, expect } from "vitest";
import {
  client,
  isEmailBearingId,
  parseArgs,
  rekey,
  type LegacyRow,
  type RekeyApi,
  type Vec,
} from "../scripts/vectorize-rekey-vector-ids.mjs";

const OLD_A = "alice@example.org:1:0";
const OLD_B = "alice@example.org:1:1";
const PUBLIC_ID = "usr_0123456789abcdef01234567:2:0";

function fakeApi(opts: { rows?: LegacyRow[]; stored?: Vec[]; changes?: (rowId: number) => number; census?: () => Promise<{ total: number; legacy: number }> } = {}) {
  const rows = opts.rows ?? [];
  const stored = new Map((opts.stored ?? []).map((v) => [v.id, v]));
  const log: string[] = [];
  const d1 = new Map(rows.map((r) => [r.rowId, r.vectorId]));
  const api: RekeyApi = {
    census: opts.census ?? (async () => ({ total: rows.length + 1, legacy: rows.length })),
    legacyRows: async () => rows,
    repoint: async (_d, rowId, oldId, newId) => {
      log.push(`repoint ${rowId}`);
      const n = opts.changes ? opts.changes(rowId) : d1.get(rowId) === oldId ? 1 : 0;
      if (n === 1) d1.set(rowId, newId);
      return n;
    },
    getByIds: async (_i, ids) => ids.map((id) => stored.get(id)).filter((v): v is Vec => !!v),
    upsert: async (_i, vs) => {
      log.push(`upsert ${vs.length}`);
      for (const v of vs) stored.set(v.id, v);
    },
    deleteByIds: async (_i, ids) => {
      log.push(`delete ${ids.length}`);
      for (const id of ids) stored.delete(id);
    },
  };
  return { api, log, stored, d1 };
}

const vec = (id: string): Vec => ({ id, values: [0.1, 0.2], metadata: { user_email: "alice@example.org", document_id: 1 } });
const opts = { index: "ix", d1: "db", dryRun: false, batch: 20 };

describe("isEmailBearingId", () => {
  it("selects the access-mode email form only", () => {
    expect(isEmailBearingId(OLD_A)).toBe(true);
    expect(isEmailBearingId(PUBLIC_ID)).toBe(false);
    expect(isEmailBearingId("c_0123456789abcdef0123456789abcdef")).toBe(false);
  });
});

describe("rekey", () => {
  it("moves every email-bearing vector: same values and metadata, new opaque id, D1 repointed, old deleted", async () => {
    const rows = [{ rowId: 1, vectorId: OLD_A }, { rowId: 2, vectorId: OLD_B }];
    const { api, log, stored, d1 } = fakeApi({ rows, stored: [vec(OLD_A), vec(OLD_B)] });
    const r = await rekey(api, opts);
    expect(r.code).toBe(0);
    expect(r.counts).toMatchObject({ legacy: 2, fetched: 2, rekeyed: 2, old_deleted: 2, gaps: 0, conflicts: 0 });
    // Add before remove: the new vectors exist before D1 moves, and D1 moves before the old go.
    expect(log).toEqual(["upsert 2", "repoint 1", "repoint 2", "delete 2"]);
    expect([...stored.keys()].some((id) => id.includes("@"))).toBe(false);
    for (const id of d1.values()) {
      expect(id).toMatch(/^c_[0-9a-f]{32}$/);
      expect(stored.get(id)?.values).toEqual([0.1, 0.2]);
      expect(stored.get(id)?.metadata).toEqual({ user_email: "alice@example.org", document_id: 1 });
    }
  });

  it("NEGATIVE CONTROL: a non-email id handed back by D1 is never touched", async () => {
    const { api, log, stored } = fakeApi({ rows: [{ rowId: 9, vectorId: PUBLIC_ID }], stored: [vec(PUBLIC_ID)] });
    const r = await rekey(api, opts);
    expect(r.code).toBe(0);
    expect(r.counts.legacy).toBe(0);
    expect(log).toEqual([]);
    expect(stored.has(PUBLIC_ID)).toBe(true);
  });

  it("a D1 id with no vector is a GAP (exit 1), not a silent skip", async () => {
    const { api } = fakeApi({ rows: [{ rowId: 1, vectorId: OLD_A }, { rowId: 2, vectorId: OLD_B }], stored: [vec(OLD_A)] });
    const r = await rekey(api, opts);
    expect(r.code).toBe(1);
    expect(r.counts).toMatchObject({ gaps: 1, rekeyed: 1 });
  });

  it("a row that changed under us is a CONFLICT: its new vector is deleted and the old one kept", async () => {
    const { api, stored } = fakeApi({ rows: [{ rowId: 1, vectorId: OLD_A }], stored: [vec(OLD_A)], changes: () => 0 });
    const r = await rekey(api, opts);
    expect(r.code).toBe(1);
    expect(r.counts).toMatchObject({ conflicts: 1, rekeyed: 0, old_deleted: 0 });
    expect([...stored.keys()]).toEqual([OLD_A]);
  });

  it("dry run writes nothing but still counts", async () => {
    const { api, log } = fakeApi({ rows: [{ rowId: 1, vectorId: OLD_A }], stored: [vec(OLD_A)] });
    const r = await rekey(api, { ...opts, dryRun: true });
    expect(r.code).toBe(0);
    expect(r.counts).toMatchObject({ legacy: 1, fetched: 1, rekeyed: 0 });
    expect(log).toEqual([]);
  });

  it("refuses (2) and writes nothing when D1 cannot be counted", async () => {
    const { api, log } = fakeApi({ rows: [{ rowId: 1, vectorId: OLD_A }], census: async () => { throw new Error("boom"); } });
    const r = await rekey(api, opts);
    expect(r.code).toBe(2);
    expect(log).toEqual([]);
  });

  it("the result carries counts only, never an id", async () => {
    const { api } = fakeApi({ rows: [{ rowId: 1, vectorId: OLD_A }], stored: [vec(OLD_A)] });
    const r = await rekey(api, opts);
    expect(JSON.stringify(r)).not.toMatch(/@|c_[0-9a-f]{32}/);
  });
});

describe("client", () => {
  it("sends the repoint as a parameterized UPDATE guarded on the old id", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ success: true, result: [{ results: [], meta: { changes: 1 } }] }));
    }) as unknown as typeof fetch;
    const n = await client({ token: "t", accountId: "acc", fetchImpl }).repoint("db", 5, OLD_A, "c_new");
    expect(n).toBe(1);
    expect(seen[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query");
    expect(seen[0].body).toEqual({ sql: "UPDATE chunks SET vector_id = ? WHERE id = ? AND vector_id = ?", params: ["c_new", 5, OLD_A] });
  });
});

describe("parseArgs", () => {
  it("requires --index and --d1 and bounds --batch", () => {
    expect(() => parseArgs(["--d1", "x"])).toThrow(/--index/);
    expect(() => parseArgs(["--index", "x"])).toThrow(/--d1/);
    expect(() => parseArgs(["--index", "x", "--d1", "y", "--batch", "0"])).toThrow(/--batch/);
    expect(parseArgs(["--index", "x", "--d1", "y", "--dry-run"])).toMatchObject({ dryRun: true, batch: 20 });
  });
});
