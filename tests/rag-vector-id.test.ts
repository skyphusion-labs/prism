// prism#232: RAG vector ids must not carry the owner's identity.
//
// Both mint sites are driven through the shipped functions: ingestDocument (upload and ZIP import)
// and handleDiscordImport (project Discord import). Only env.AI / env.VEC / env.DB / env.R2 are
// stubbed, plus the request identity. The caller is an access-mode identity (a raw email), which is
// the case the issue is about.

import { describe, it, expect, vi } from "vitest";

const EMAIL = "alice.example@example.org";

vi.mock("../src/routes/shared", async (orig) => {
  const real = await orig<typeof import("../src/routes/shared")>();
  return { ...real, getUserEmail: async () => EMAIL };
});

import { ingestDocument } from "../src/routes/rag";
import { handleDiscordImport } from "../src/routes/projects";
import { mintVectorId, isOpaqueVectorId } from "../src/vector-id";
import { mintVectorId as scriptMint } from "../scripts/vectorize-rekey-vector-ids.mjs";
import type { Env } from "../src/env";

interface Upserted {
  id: string;
  metadata?: Record<string, unknown>;
}

/** Fake bindings: records every Vectorize upsert and every D1 statement with its bound args. */
function fakeEnv() {
  const upserts: Upserted[] = [];
  const statements: { sql: string; args: unknown[] }[] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      statements.push({ sql, args });
      if (sql.includes("user_prefs")) return { prefs_json: JSON.stringify({ gateway_id: "gw" }) };
      if (sql.includes("RETURNING id")) return { id: 7, created_at: "2026-11-12 00:00:00" };
      if (sql.includes("FROM projects")) return { id: 3 };
      return null;
    },
    async run() {
      statements.push({ sql, args });
      return { meta: { changes: 1 } };
    },
    async all() {
      statements.push({ sql, args });
      return { results: [] };
    },
  });
  const env = {
    AI: {
      run: async (_m: string, input: { text: string[] }) => ({
        shape: [input.text.length, 3],
        data: input.text.map(() => [0.1, 0.2, 0.3]),
      }),
    },
    VEC: {
      upsert: async (vs: Upserted[]) => {
        upserts.push(...vs);
        return { mutationId: "m" };
      },
      deleteByIds: async () => ({ mutationId: "m" }),
    },
    R2: { put: async () => ({}), delete: async () => {} },
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (ss: { sql: string; args: unknown[] }[]) => {
        for (const s of ss) statements.push({ sql: s.sql, args: s.args });
        return ss.map(() => ({ meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;
  const chunkRowVectorIds = () =>
    statements.filter((s) => s.sql.includes("INSERT INTO chunks")).map((s) => String(s.args[4]));
  return { env, upserts, chunkRowVectorIds };
}

/** The check under test. It must be able to go red: see the negative control below. */
function carriesIdentity(id: string, identity: string): boolean {
  return id.includes(identity) || id.includes("@");
}

describe("mintVectorId", () => {
  it("is c_ plus 32 hex digits, unique per call, and carries no @", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintVectorId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(isOpaqueVectorId(id), id).toBe(true);
      expect(id.length).toBe(34);
      expect(id).not.toContain("@");
    }
  });

  it("the re-key script mints the same format as the worker", () => {
    expect(isOpaqueVectorId(scriptMint())).toBe(true);
  });
});

describe("NEGATIVE CONTROL: the identity check can go red", () => {
  it("flags the pre-prism#232 id shape", () => {
    expect(carriesIdentity(`${EMAIL}:7:0`, EMAIL)).toBe(true);
    expect(isOpaqueVectorId(`${EMAIL}:7:0`)).toBe(false);
    expect(carriesIdentity(mintVectorId(), EMAIL)).toBe(false);
  });
});

describe("ingestDocument (upload, ZIP import)", () => {
  it("writes vector ids with no identity, the same id to D1, and keeps ownership in metadata", async () => {
    const { env, upserts, chunkRowVectorIds } = fakeEnv();
    const text = "Paragraph one about the shaft.\n\n".repeat(60);
    const r = await ingestDocument(env, EMAIL, "notes.txt", "text/plain", new TextEncoder().encode(text));
    expect(r.ok).toBe(true);
    expect(upserts.length).toBeGreaterThan(1);
    for (const v of upserts) {
      expect(carriesIdentity(v.id, EMAIL), v.id).toBe(false);
      expect(isOpaqueVectorId(v.id), v.id).toBe(true);
      expect(v.metadata?.user_email).toBe(EMAIL);
    }
    expect(chunkRowVectorIds()).toEqual(upserts.map((v) => v.id));
  });
});

describe("handleDiscordImport (project Discord import)", () => {
  it("writes vector ids with no identity, the same id to D1, and keeps ownership in metadata", async () => {
    const { env, upserts, chunkRowVectorIds } = fakeEnv();
    const exportJson = {
      guild: { id: "1", name: "G" },
      channel: { id: "10", type: "GuildTextChat", category: "c", name: "general", topic: null },
      messages: Array.from({ length: 6 }, (_, i) => ({
        id: String(100 + i),
        type: "Default",
        timestamp: new Date(Date.UTC(2024, 0, 15, 12, i * 30)).toISOString(),
        content: `message ${i} about the transit hub`,
        author: { id: "a", name: "alice", discriminator: "0", nickname: null, isBot: false },
      })),
    };
    const data = Buffer.from(JSON.stringify(exportJson)).toString("base64");
    const req = new Request("https://x/api/projects/3/discord", {
      method: "POST",
      body: JSON.stringify({ filename: "export.json", data }),
    });
    const res = await handleDiscordImport(req, env, 3);
    expect(res.status).toBeLessThan(300);
    expect(upserts.length).toBeGreaterThan(0);
    for (const v of upserts) {
      expect(carriesIdentity(v.id, EMAIL), v.id).toBe(false);
      expect(isOpaqueVectorId(v.id), v.id).toBe(true);
      expect(v.metadata?.user_email).toBe(EMAIL);
    }
    expect(chunkRowVectorIds()).toEqual(upserts.map((v) => v.id));
  });
});
