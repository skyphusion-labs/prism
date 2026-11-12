// The zero-join retrieval diagnostic (skyphusion-labs/fleet-chezmoi#1608, prism#233).
//
// With VEC_METADATA_FILTER off, retrieveContext queries Vectorize globally and scopes by user in the
// D1 join. So the raw Vectorize result can hold vector ids belonging to other users, and
// pre-prism#232 ids embed an email. The zero-join branch is where those ids sit next to two outputs:
//
//   - the string returned to the caller (fleet-chezmoi#1608): nothing derived from the shared index.
//   - the operator log (prism#233): counts and opaque row ids only. No caller identity, no foreign
//     identity, no vector id.
//
// Only env.AI / env.VEC / env.DB are stubbed. Everything between them is the shipped retrieveContext.

import { describe, it, expect, vi, afterEach } from "vitest";
import { retrieveContext } from "../src/routes/rag";
import type { Env } from "../src/env";

const CALLER = "alice@example.com";
const FOREIGN_IDS = [
  "victim@example.com:7:0",
  "usr_0123456789abcdef01234567:12:3",
  "bob@example.com:99:2",
];

// Neither output may contain any of these. Kept as the identity half of each id as well as the whole
// id, so the assertion still fires if only the identity survives some future re-formatting.
const FOREIGN_IDENTITIES = ["victim@example.com", "usr_0123456789abcdef01234567", "bob@example.com"];
const FORBIDDEN_IN_LOG = [CALLER, ...FOREIGN_IDS, ...FOREIGN_IDENTITIES];

type Census = { held: number; own: number } | "throw" | null;

function fakeEnv(census: Census = { held: 2, own: 0 }) {
  const vecReturned: string[] = [];
  const env = {
    AI: {
      run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }),
    },
    VEC: {
      query: async () => {
        vecReturned.push(...FOREIGN_IDS);
        return { matches: FOREIGN_IDS.map((id, i) => ({ id, score: 0.9 - i * 0.01 })) };
      },
    },
    DB: {
      prepare(sql: string) {
        const isPrefs = sql.includes("user_prefs");
        const isCensus = sql.includes("COUNT(*) AS held");
        return {
          bind() {
            return {
              async first() {
                if (isPrefs) return { prefs_json: JSON.stringify({ gateway_id: "alice-gw" }) };
                if (isCensus) {
                  if (census === "throw") throw new Error(`D1 down for ${CALLER}`);
                  return census;
                }
                return null;
              },
              // The tenant-scoped join finds none of the matched vectors: the branch under test.
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, vecReturned };
}

function logged(warn: ReturnType<typeof vi.spyOn>): string {
  return warn.mock.calls.map((c) => c.join(" ")).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retrieveContext zero-join: the caller-visible message", () => {
  it("carries no foreign identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fakeEnv();
    const { chunks, error } = await retrieveContext(env, CALLER, "quarterly revenue");
    expect(chunks).toEqual([]);
    // Disclosure assertion first, so it is the one that fires under the defect; the branch pin
    // second, as the anti-vacuity control (earlier failure paths are also identity-free).
    for (const identity of FOREIGN_IDENTITIES) expect(error).not.toContain(identity);
    expect(error).toBe("No indexed documents matched the query.");
  });

  it("is scoped the same way with a project", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fakeEnv();
    const { error } = await retrieveContext(env, CALLER, "quarterly revenue", 5, 42);
    for (const identity of FOREIGN_IDENTITIES) expect(error).not.toContain(identity);
    expect(error).toBe("No indexed documents in this project matched the query.");
  });
});

describe("retrieveContext zero-join: the operator log (prism#233)", () => {
  it("carries no caller identity, no foreign identity and no vector id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, vecReturned } = fakeEnv();
    await retrieveContext(env, CALLER, "quarterly revenue");
    const log = logged(warn);
    // Disclosure assertion first (see above).
    for (const s of FORBIDDEN_IN_LOG) expect(log, s).not.toContain(s);
    expect(log).not.toMatch(/@/);
    // Anti-vacuity: the log was written, on this branch, after the identities were really fed in.
    expect(log).toContain("zero-join matches=3");
    expect(vecReturned).toEqual(FOREIGN_IDS);
  });

  it("keeps the diagnostic: counts say the vectors were written under another identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fakeEnv({ held: 2, own: 0 });
    await retrieveContext(env, CALLER, "quarterly revenue");
    expect(logged(warn)).toContain("matches=3 held_by_caller=0 held_by_other_users=2 not_in_d1=1");
  });

  it("with a project: opaque project id and the caller-owned count, still no identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fakeEnv({ held: 3, own: 3 });
    await retrieveContext(env, CALLER, "quarterly revenue", 5, 42);
    const log = logged(warn);
    for (const s of FORBIDDEN_IN_LOG) expect(log, s).not.toContain(s);
    expect(log).toContain("matches=3 project_id=42 held_by_caller=3 held_by_other_users=0 not_in_d1=0");
  });

  it("a failed census logs census=unavailable, and its error text (which names the caller) is not logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fakeEnv("throw");
    await retrieveContext(env, CALLER, "quarterly revenue");
    const log = logged(warn);
    for (const s of FORBIDDEN_IN_LOG) expect(log, s).not.toContain(s);
    expect(log).toContain("zero-join matches=3 census=unavailable");
  });
});

describe("NEGATIVE CONTROL", () => {
  it("the log check goes red on a line shaped like the pre-prism#233 diagnostic", () => {
    const old = `Vectorize returned 3 matches but D1 join returned 0. user_email='${CALLER}', sample vector_ids=[${FOREIGN_IDS.join(", ")}].`;
    expect(FORBIDDEN_IN_LOG.some((s) => old.includes(s))).toBe(true);
  });

  it("the fixture really does supply foreign ids", () => {
    expect(FOREIGN_IDS.length).toBeGreaterThan(0);
    expect(FOREIGN_IDENTITIES.length).toBe(FOREIGN_IDS.length);
    for (const id of FOREIGN_IDS) expect(id.split(":")[0]).not.toBe(CALLER);
  });
});
