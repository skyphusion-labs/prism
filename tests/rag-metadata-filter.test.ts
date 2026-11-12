// VEC_METADATA_FILTER: retrieval filtered by user in Vectorize itself (skyphusion-labs/fleet-chezmoi#1636).
//
// THE DEFECT. With a global Vectorize query, a caller holding a small share of a large index can get a
// top-K made entirely of other users' vectors. The D1 join (the tenant scope) drops all of them, and the
// caller sees nothing even though their own document matches. The flag filters the query on user_email.
//
// The fake index below HONOURS the filter the way Vectorize does: unfiltered, it returns the global
// top-K; filtered, only vectors whose metadata matches. The fake D1 honours the join's user_email
// scope. Only env.AI / env.VEC / env.DB are stubbed; retrieveContext is the shipped function.

import { describe, it, expect, vi, afterEach } from "vitest";
import { retrieveContext, vecMetadataFilterOn } from "../src/routes/rag";
import type { Env } from "../src/env";

const CALLER = "usr_0123456789abcdef01234567";
const STRANGER = "usr_fedcba9876543210fedcba98";

interface StoredVector {
  id: string;
  score: number;
  owner: string;
}

/** Five foreign vectors scoring above the caller's one: the crowding shape. */
const CROWDED: StoredVector[] = [
  ...[0, 1, 2, 3, 4].map((i) => ({ id: `${STRANGER}:9:${i}`, score: 0.95 - i * 0.01, owner: STRANGER })),
  { id: `${CALLER}:1:0`, score: 0.6, owner: CALLER },
];

type QueryOpts = { topK: number; filter?: Record<string, string> };

function fakeEnv(index: StoredVector[], flag?: string) {
  const queries: QueryOpts[] = [];
  const joinSql: string[] = [];
  const env = {
    VEC_METADATA_FILTER: flag,
    AI: { run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }) },
    VEC: {
      query: async (_v: number[], opts: QueryOpts) => {
        queries.push(opts);
        const pool = opts.filter ? index.filter((v) => v.owner === opts.filter!.user_email) : index;
        const top = [...pool].sort((a, b) => b.score - a.score).slice(0, opts.topK);
        return { matches: top.map((v) => ({ id: v.id, score: v.score })) };
      },
    },
    DB: {
      prepare(sql: string) {
        const isPrefs = sql.includes("user_prefs");
        if (!isPrefs) joinSql.push(sql);
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                return isPrefs ? { prefs_json: JSON.stringify({ gateway_id: "gw" }) } : null;
              },
              async all() {
                // The tenant scope: only the bound user_email's own vectors join.
                const user = args[0] as string;
                const ids = args.slice(1) as string[];
                const rows = index
                  .filter((v) => v.owner === user && ids.includes(v.id))
                  .map((v) => ({ document_id: 1, chunk_index: 0, text: "own text", vector_id: v.id, filename: "own.txt", page: null, sheet: null }));
                return { results: rows };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries, joinSql };
}

afterEach(() => vi.restoreAllMocks());

describe("vecMetadataFilterOn", () => {
  it("is on only for an explicit on / 1 / true", () => {
    for (const v of ["on", "1", "true", " ON "]) expect(vecMetadataFilterOn({ VEC_METADATA_FILTER: v }), v).toBe(true);
    for (const v of [undefined, "", "off", "0", "yes", "false"]) expect(vecMetadataFilterOn({ VEC_METADATA_FILTER: v }), String(v)).toBe(false);
  });
});

describe("retrieveContext with VEC_METADATA_FILTER", () => {
  it("OFF (the default): the query is global, and the D1 join still scopes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, queries, joinSql } = fakeEnv(CROWDED);
    await retrieveContext(env, CALLER, "q");
    expect(queries).toHaveLength(1);
    expect(queries[0].filter).toBeUndefined();
    expect(joinSql.some((s) => s.includes("c.user_email = ?"))).toBe(true);
  });

  it("ON: the query carries filter { user_email: caller }, and the D1 join still scopes", async () => {
    const { env, queries, joinSql } = fakeEnv(CROWDED, "on");
    await retrieveContext(env, CALLER, "q");
    expect(queries[0].filter).toEqual({ user_email: CALLER });
    expect(joinSql.some((s) => s.includes("c.user_email = ?"))).toBe(true);
  });

  it("THE DEFECT, OFF: a crowded index gives the caller nothing although their own vector matches", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fakeEnv(CROWDED);
    const { chunks } = await retrieveContext(env, CALLER, "q");
    expect(chunks).toEqual([]);
  });

  it("POSITIVE, ON: the same crowded index returns the caller's own chunk", async () => {
    const { env } = fakeEnv(CROWDED, "on");
    const { chunks } = await retrieveContext(env, CALLER, "q");
    expect(chunks.map((c) => c.filename)).toEqual(["own.txt"]);
  });

  it("NEGATIVE CONTROL, ON: a caller who owns nothing gets nothing, and no foreign vector is returned", async () => {
    const nobody = "usr_000000000000000000000000";
    const { env, queries } = fakeEnv(CROWDED, "on");
    const query = env.VEC.query.bind(env.VEC);
    let seen: { id: string }[] = [];
    (env.VEC as unknown as { query: typeof query }).query = async (v, o) => {
      const r = await query(v, o);
      seen = r.matches;
      return r;
    };
    const { chunks } = await retrieveContext(env, nobody, "q");
    expect(queries[0].filter).toEqual({ user_email: nobody });
    expect(seen).toEqual([]);
    expect(chunks).toEqual([]);
  });

  it("ON with a project: the overfetch stays 3x topK and is drawn from the caller's own vectors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, queries } = fakeEnv(CROWDED, "on");
    await retrieveContext(env, CALLER, "q", 5, 42);
    expect(queries[0]).toEqual({ topK: 15, filter: { user_email: CALLER } });
  });
});
