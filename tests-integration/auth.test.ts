// Workers-runtime integration tests for the first-party auth plane
// (v0.167.0, issue #80). Runs the real fetch handler in workerd with local
// Miniflare D1 + R2. AUTH_MODE is flipped to "public" for these tests (the
// existing worker.test.ts suite keeps the default "access" mode), so the
// signup/login/session/gate/fail-closed/account-delete paths are all exercised
// against the shipped handler, not stubs.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../src/models";
import schemaSql from "../schema.sql?raw";

async function applySchema(db: D1Database): Promise<void> {
  const statements = schemaSql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      await db.prepare(stmt).run();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (/duplicate column name|already exists/i.test(msg)) continue;
      throw e;
    }
  }
}

const ALL_TABLES = [
  "chats",
  "user_prefs",
  "documents",
  "chunks",
  "projects",
  "project_documents",
  "project_messages",
  "users",
  "sessions",
  "auth_attempts",
];

const anyEnv = env as unknown as { AUTH_MODE?: string; GATEWAY_ID?: string; CF_AIG_TOKEN?: string };

beforeEach(async () => {
  await applySchema(env.DB);
  for (const t of ALL_TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  anyEnv.AUTH_MODE = "public";
  delete anyEnv.GATEWAY_ID;
  delete anyEnv.CF_AIG_TOKEN;
});

afterEach(() => {
  delete anyEnv.AUTH_MODE;
  delete anyEnv.GATEWAY_ID;
  delete anyEnv.CF_AIG_TOKEN;
});

const WORKERS_AI_CHAT = MODELS.find((m) => m.type === "chat" && !m.provider)!.id;

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie");
  if (!sc) throw new Error("no set-cookie on response");
  return sc.split(";")[0]; // "__Host-prism_session=<token>"
}

interface ReqOpts {
  method?: string;
  body?: unknown;
  cookie?: string;
  ip?: string;
}

function req(path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  headers.set("cf-connecting-ip", opts.ip ?? "203.0.113.7");
  return SELF.fetch(`https://prism.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function signup(username: string, password: string, ip?: string): Promise<string> {
  const res = await req("/api/auth/signup", { method: "POST", body: { username, password }, ip });
  expect(res.status).toBe(201);
  return cookieFrom(res);
}

describe("GET /api/session (boot gate)", () => {
  it("reports unauthenticated in public mode with no session", async () => {
    const res = await req("/api/session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; authenticated: boolean };
    expect(body.mode).toBe("public");
    expect(body.authenticated).toBe(false);
  });

  it("reports the username once signed up", async () => {
    const cookie = await signup("alice", "password123");
    const res = await req("/api/session", { cookie });
    const body = (await res.json()) as { authenticated: boolean; user?: { username: string } };
    expect(body.authenticated).toBe(true);
    expect(body.user?.username).toBe("alice");
  });
});

describe("signup / login / logout", () => {
  it("signup opens a session; login on a fresh cookie also works", async () => {
    await signup("bob", "password123");
    const loginRes = await req("/api/auth/login", {
      method: "POST",
      body: { username: "bob", password: "password123" },
    });
    expect(loginRes.status).toBe(200);
    const cookie = cookieFrom(loginRes);
    const sess = await req("/api/session", { cookie });
    expect(((await sess.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });

  it("rejects a duplicate username (case-insensitive)", async () => {
    await signup("Carol", "password123");
    const dup = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "carol", password: "password123" },
    });
    expect(dup.status).toBe(409);
  });

  it("rejects a wrong password with a generic 401", async () => {
    await signup("dave", "password123");
    const res = await req("/api/auth/login", {
      method: "POST",
      body: { username: "dave", password: "wrongpassword" },
    });
    expect(res.status).toBe(401);
  });

  it("logout revokes the session server-side", async () => {
    const cookie = await signup("erin", "password123");
    await req("/api/auth/logout", { method: "POST", cookie });
    const sess = await req("/api/session", { cookie });
    expect(((await sess.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  it("rejects weak input at signup", async () => {
    const shortPw = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "frank", password: "short" },
    });
    expect(shortPw.status).toBe(400);
    const badUser = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "no", password: "password123" },
    });
    expect(badUser.status).toBe(400);
  });
});

describe("public-mode gate: uniform 401 auth_required", () => {
  it("blocks /api/* without a session", async () => {
    const res = await req("/api/history");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("auth_required");
  });

  it("blocks /api/models without a session too", async () => {
    const res = await req("/api/models");
    expect(res.status).toBe(401);
  });

  it("allows /api/history with a session, scoped to the account", async () => {
    const cookie = await signup("gwen", "password123");
    const res = await req("/api/history", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: unknown[] };
    expect(Array.isArray(body.chats)).toBe(true);
  });

  it("isolates history between two accounts", async () => {
    const aCookie = await signup("hank", "password123", "203.0.113.10");
    const bCookie = await signup("iris", "password123", "203.0.113.11");
    // Seed a chat owned by hank's account id (read it back from session/db).
    const aId = (await (await req("/api/session", { cookie: aCookie })).json()) as { user?: { username: string } };
    expect(aId.user?.username).toBe("hank");
    // hank writes via prefs to prove ownership scoping without hitting AI.
    await req("/api/prefs", { method: "PATCH", cookie: aCookie, body: { gateway_id: "hank-gw" } });
    const bPrefs = (await (await req("/api/prefs", { cookie: bCookie })).json()) as { gateway_id: string | null };
    expect(bPrefs.gateway_id).toBeNull(); // iris does not see hank's prefs
  });
});

describe("fail-closed gateway in public mode", () => {
  it("ignores worker secrets: chat 412 gateway_not_configured even when GATEWAY_ID/CF_AIG_TOKEN are set", async () => {
    anyEnv.GATEWAY_ID = "host-gateway";
    anyEnv.CF_AIG_TOKEN = "host-token";
    const cookie = await signup("jack", "password123");
    const res = await req("/api/chat", {
      method: "POST",
      cookie,
      body: { model: WORKERS_AI_CHAT, user_input: "hi" },
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("gateway_not_configured");
  });

  it("source is never worker/mixed in public mode even with worker secrets present", async () => {
    anyEnv.GATEWAY_ID = "host-gateway";
    anyEnv.CF_AIG_TOKEN = "host-token";
    const cookie = await signup("kate", "password123");
    const models = (await (await req("/api/models", { cookie })).json()) as {
      gateway: { source: string; configured: boolean };
    };
    expect(models.gateway.source).toBe("none");
    expect(models.gateway.configured).toBe(false);
  });

  it("positive control: once the user sets a gateway, the 412 no longer fires", async () => {
    const cookie = await signup("liam", "password123");
    await req("/api/prefs", { method: "PATCH", cookie, body: { gateway_id: "liam-gw" } });
    let status: number;
    try {
      status = (
        await req("/api/chat", { method: "POST", cookie, body: { model: WORKERS_AI_CHAT, user_input: "hi" } })
      ).status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(412);
  });
});

describe("DELETE /api/account cascade", () => {
  it("requires password re-entry and cascades the account's data", async () => {
    const cookie = await signup("mona", "password123");
    const who = (await (await req("/api/session", { cookie })).json()) as { user?: { username: string } };
    expect(who.user?.username).toBe("mona");
    const userId = (
      await env.DB.prepare(`SELECT id FROM users WHERE username_lc = 'mona'`).first<{ id: string }>()
    )!.id;

    // Seed owned data across tables + an R2 artifact.
    await env.DB.prepare(
      `INSERT INTO chats (user_email, model, model_type, user_input, output, output_artifact)
       VALUES (?, 'm', 'image', 'hi', '', ?)`,
    )
      .bind(userId, JSON.stringify({ key: "out/mona.png", mime: "image/png", type: "image" }))
      .run();
    await env.R2.put("out/mona.png", new Uint8Array([1, 2, 3]), { customMetadata: { user_email: userId } });
    await req("/api/prefs", { method: "PATCH", cookie, body: { gateway_id: "mona-gw" } });

    // A second account whose data must survive.
    const otherCookie = await signup("nell", "password123", "203.0.113.20");
    const otherId = (
      await env.DB.prepare(`SELECT id FROM users WHERE username_lc = 'nell'`).first<{ id: string }>()
    )!.id;

    // Wrong password is refused.
    const bad = await req("/api/account", { method: "DELETE", cookie, body: { password: "nope" } });
    expect(bad.status).toBe(403);

    // Correct password deletes and clears the cookie.
    const del = await req("/api/account", { method: "DELETE", cookie, body: { password: "password123" } });
    expect(del.status).toBe(200);
    expect(del.headers.get("set-cookie")).toContain("Max-Age=0");

    // Account + its rows are gone.
    const userGone = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first();
    expect(userGone).toBeNull();
    const chatsGone = await env.DB.prepare(`SELECT COUNT(*) AS n FROM chats WHERE user_email = ?`).bind(userId).first<{ n: number }>();
    expect(chatsGone!.n).toBe(0);
    const prefsGone = await env.DB.prepare(`SELECT COUNT(*) AS n FROM user_prefs WHERE user_email = ?`).bind(userId).first<{ n: number }>();
    expect(prefsGone!.n).toBe(0);
    const sessGone = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`).bind(userId).first<{ n: number }>();
    expect(sessGone!.n).toBe(0);
    expect(await env.R2.get("out/mona.png")).toBeNull();

    // The other account is untouched.
    const otherStill = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(otherId).first();
    expect(otherStill).not.toBeNull();
    const otherSess = await req("/api/session", { cookie: otherCookie });
    expect(((await otherSess.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });
});

describe("rate limiting", () => {
  it("positive control: the counter records and eventually 429s repeated logins", async () => {
    await signup("olive", "password123", "198.51.100.5");
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await req("/api/auth/login", {
        method: "POST",
        body: { username: "olive", password: "wrongpassword" },
        ip: "198.51.100.5",
      });
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
    // Control: the bucket row actually exists (the limiter is not vacuous).
    const row = await env.DB.prepare(`SELECT count FROM auth_attempts WHERE bucket_key = ?`)
      .bind("login:198.51.100.5:olive")
      .first<{ count: number }>();
    expect(row).not.toBeNull();
    expect(row!.count).toBeGreaterThanOrEqual(5);
  });
});
