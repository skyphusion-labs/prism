// scripts/vectorize-backfill-metadata.mjs (skyphusion-labs/fleet-chezmoi#1636): the refusals, the
// counts, and that it never surfaces an id. The REST client is driven through a recording fetch.

import { describe, it, expect } from "vitest";
import {
  backfill,
  client,
  hasUserEmailIndex,
  parseArgs,
  type BackfillApi,
  type Vec,
} from "../scripts/vectorize-backfill-metadata.mjs";

const IDX = [{ propertyName: "user_email", indexType: "String" }];
const vec = (id: string, owner: string | null = "usr_a"): Vec => ({
  id,
  values: [0.1, 0.2],
  metadata: owner === null ? { document_id: 1 } : { user_email: owner, document_id: 1 },
});

function fakeApi(over: Partial<BackfillApi> & { stored?: Vec[] } = {}) {
  const stored = over.stored ?? [];
  const calls = { getByIds: [] as string[][], upsert: [] as Vec[][], ids: 0 };
  const api: BackfillApi = {
    metadataIndexes: over.metadataIndexes ?? (async () => IDX),
    vectorIds: async () => [],
    getByIds:
      over.getByIds ??
      (async (_i, ids) => {
        calls.getByIds.push(ids);
        return stored.filter((v) => ids.includes(v.id));
      }),
    upsert:
      over.upsert ??
      (async (_i, vs) => {
        calls.upsert.push(vs);
      }),
  };
  return { api, calls };
}

const run = (api: BackfillApi, ids: string[], extra: Partial<{ dryRun: boolean; batch: number }> = {}) =>
  backfill(api, { index: "ix", d1: "db", dryRun: false, batch: 20, ...extra, idsFrom: async () => ids });

describe("refusals: nothing is written", () => {
  it("refuses (2) when there is no user_email metadata index, and never reads the ids", async () => {
    let read = false;
    const { api, calls } = fakeApi({ metadataIndexes: async () => [] });
    const r = await backfill(api, { index: "ix", d1: "db", dryRun: false, batch: 20, idsFrom: async () => ((read = true), ["a"]) });
    expect(r.code).toBe(2);
    expect(r.refusal).toMatch(/create-metadata-index ix --property-name=user_email --type=string/);
    expect(read).toBe(false);
    expect(calls.upsert).toEqual([]);
  });

  it("refuses when the index exists on user_email but is not a string index", async () => {
    expect(hasUserEmailIndex([{ propertyName: "user_email", indexType: "Number" }])).toBe(false);
    const { api, calls } = fakeApi({ metadataIndexes: async () => [{ propertyName: "user_email", indexType: "Number" }] });
    expect((await run(api, ["a"])).code).toBe(2);
    expect(calls.upsert).toEqual([]);
  });

  it("refuses when the metadata index list cannot be read", async () => {
    const { api } = fakeApi({ metadataIndexes: async () => { throw new Error("HTTP 403"); } });
    expect((await run(api, ["a"])).code).toBe(2);
  });

  it("refuses when the D1 ids cannot be read", async () => {
    const { api, calls } = fakeApi();
    const r = await backfill(api, { index: "ix", d1: "db", dryRun: false, batch: 20, idsFrom: async () => { throw new Error("d1"); } });
    expect(r.code).toBe(2);
    expect(calls.upsert).toEqual([]);
  });
});

describe("the backfill", () => {
  it("COMPLETE (0): every D1 id is fetched and written back with the same id, values and metadata", async () => {
    const stored = [vec("a"), vec("b"), vec("c")];
    const { api, calls } = fakeApi({ stored });
    const r = await run(api, ["a", "b", "c"]);
    expect(r).toMatchObject({ code: 0, counts: { d1_ids: 3, fetched: 3, upserted: 3, gaps: 0, missing_metadata: 0 } });
    expect(calls.upsert.flat()).toEqual(stored);
  });

  it("a D1 id Vectorize cannot return is a GAP (1), never skipped silently; the rest still land", async () => {
    const { api, calls } = fakeApi({ stored: [vec("a"), vec("c")] });
    const r = await run(api, ["a", "b", "c"]);
    expect(r).toMatchObject({ code: 1, counts: { d1_ids: 3, fetched: 2, gaps: 1, upserted: 2 } });
    expect(calls.upsert.flat().map((v) => v.id)).toEqual(["a", "c"]);
  });

  it("a vector with no user_email metadata is counted (1) and not re-upserted", async () => {
    const { api, calls } = fakeApi({ stored: [vec("a"), vec("b", null)] });
    const r = await run(api, ["a", "b"]);
    expect(r).toMatchObject({ code: 1, counts: { missing_metadata: 1, upserted: 1 } });
    expect(calls.upsert.flat().map((v) => v.id)).toEqual(["a"]);
  });

  it("--dry-run writes nothing and reports what it would do", async () => {
    const { api, calls } = fakeApi({ stored: [vec("a")] });
    const r = await run(api, ["a"], { dryRun: true });
    expect(r).toMatchObject({ code: 0, counts: { fetched: 1, upserted: 0 } });
    expect(calls.upsert).toEqual([]);
  });

  it("batches by --batch", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const { api, calls } = fakeApi({ stored: ids.map((i) => vec(i)) });
    await run(api, ids, { batch: 2 });
    expect(calls.getByIds).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("the result carries counts only: no id, no value, no metadata value", async () => {
    const secretId = "someone@example.com:7:0";
    const { api } = fakeApi({ stored: [vec(secretId, "someone@example.com")] });
    const r = await run(api, [secretId, "missing@example.com:1:0"]);
    const out = JSON.stringify(r);
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("0.1");
  });
});

describe("parseArgs", () => {
  it("requires --index and --d1, and bounds --batch", () => {
    expect(parseArgs(["--index", "ix", "--d1", "db"])).toEqual({ index: "ix", d1: "db", dryRun: false, batch: 20 });
    expect(() => parseArgs(["--d1", "db"])).toThrow(/--index/);
    expect(() => parseArgs(["--index", "ix"])).toThrow(/--d1/);
    expect(() => parseArgs(["--index", "ix", "--d1", "db", "--batch", "0"])).toThrow(/--batch/);
    expect(() => parseArgs(["--index", "ix", "--d1", "db", "--nope"])).toThrow(/unknown/);
  });
});

describe("client: the REST wire shapes", () => {
  function recorder(results: Record<string, unknown>) {
    const seen: { url: string; method?: string; type?: string | null; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, method: init.method, type: new Headers(init.headers).get("content-type"), body: init.body as string });
      const key = Object.keys(results).find((k) => url.endsWith(k))!;
      return new Response(JSON.stringify({ success: true, result: results[key] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, api: client({ token: "t", accountId: "acct", fetchImpl }) };
  }

  it("reads metadata indexes, D1 ids, get_by_ids, and upserts NDJSON", async () => {
    const { seen, api } = recorder({
      "/metadata_index/list": { metadataIndexes: IDX },
      "/query": [{ results: [{ vector_id: "a" }, { vector_id: "b" }] }],
      "/get_by_ids": [vec("a")],
      "/upsert": { mutationId: "m" },
    });
    expect(await api.metadataIndexes("ix")).toEqual(IDX);
    expect(await api.vectorIds("db")).toEqual(["a", "b"]);
    expect(await api.getByIds("ix", ["a"])).toEqual([vec("a")]);
    await api.upsert("ix", [vec("a"), vec("b")]);
    const up = seen.find((s) => s.url.endsWith("/upsert"))!;
    expect(up.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/vectorize/v2/indexes/ix/upsert");
    expect(up.type).toBe("application/x-ndjson");
    expect(up.body!.split("\n").map((l) => JSON.parse(l).id)).toEqual(["a", "b"]);
    expect(seen.find((s) => s.url.endsWith("/query"))!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query");
  });

  it("throws on a failed call rather than returning an empty answer", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 })) as unknown as typeof fetch;
    await expect(client({ token: "t", accountId: "a", fetchImpl }).metadataIndexes("ix")).rejects.toThrow(/HTTP 403/);
  });
});
