// Workers-runtime integration tests for the first-party auth plane
// (v0.167.0, issue #80). Runs the real fetch handler in workerd with local
// Miniflare D1 + R2. AUTH_MODE is flipped to "public" for these tests (the
// existing worker.test.ts suite keeps the default "access" mode), so the
// signup/login/boot-envelope/gate/fail-closed/account-delete paths are all
// exercised against the shipped handler, not stubs.
//
// Boot contract: there is NO /api/session endpoint; GET /api/models is the
// unauthenticated boot probe and carries { mode, authenticated, user, username }.

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

// v1.1.0: a user's Cloudflare account id (any 32 hex will do under the stubs).
const USER_ACCT = "0123456789abcdef0123456789abcdef";

const WORKERS_AI_CHAT = MODELS.find((m) => m.type === "chat" && !m.provider)!.id;
const STREAM_CHAT = MODELS.find((m) => m.type === "chat" && m.streaming && !m.provider)?.id
  ?? MODELS.find((m) => m.type === "chat" && m.streaming)!.id;

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

interface BootEnvelope {
  mode: string;
  authenticated: boolean;
  user: string | null;
  username: string | null;
  gateway: { source: string; configured: boolean };
}

async function boot(cookie?: string): Promise<BootEnvelope> {
  return (await (await req("/api/models", { cookie })).json()) as BootEnvelope;
}

async function signup(username: string, password: string, ip?: string): Promise<string> {
  const res = await req("/api/auth/signup", { method: "POST", body: { username, password }, ip });
  expect(res.status).toBe(201);
  return cookieFrom(res);
}

describe("GET /api/models boot envelope (no /api/session)", () => {
  it("is reachable unauthenticated and reports mode + authenticated=false + user null", async () => {
    const res = await req("/api/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootEnvelope & { models: unknown[] };
    expect(body.mode).toBe("public");
    expect(body.authenticated).toBe(false);
    expect(body.user).toBeNull();
    expect(body.username).toBeNull();
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("reports authenticated + username once signed up", async () => {
    const cookie = await signup("alice", "password123");
    const b = await boot(cookie);
    expect(b.authenticated).toBe(true);
    expect(b.username).toBe("alice");
    expect(b.user).toMatch(/^usr_/);
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
    expect((await boot(cookie)).authenticated).toBe(true);
  });

  it("rejects a duplicate username (case-insensitive)", async () => {
    await signup("Carol", "password123");
    const dup = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "carol", password: "password123" },
    });
    expect(dup.status).toBe(409);
  });

  it("stores the cased username but compares lowercased", async () => {
    const cookie = await signup("MixedCase", "password123");
    expect((await boot(cookie)).username).toBe("MixedCase");
    const dup = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "mixedcase", password: "password123" },
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
    expect((await boot(cookie)).authenticated).toBe(false);
  });

  it("enforces the validation contract with a stable code", async () => {
    const shortPw = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "frank", password: "short1234" }, // 9 chars
    });
    expect(shortPw.status).toBe(400);
    const dotUser = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "has.dot", password: "password123" },
    });
    expect(dotUser.status).toBe(400);
    const shortUser = await req("/api/auth/signup", {
      method: "POST",
      body: { username: "no", password: "password123" },
    });
    expect(shortUser.status).toBe(400);
  });
});

describe("public-mode gate: uniform 401 unauthenticated", () => {
  it("blocks /api/* without a session, with code unauthenticated", async () => {
    const res = await req("/api/history");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthenticated");
  });

  it("does NOT block GET /api/models (the boot probe stays reachable)", async () => {
    expect((await req("/api/models")).status).toBe(200);
  });

  it("allows /api/history with a session, scoped to the account", async () => {
    const cookie = await signup("gwen", "password123");
    const res = await req("/api/history", { cookie });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { chats: unknown[] }).chats)).toBe(true);
  });

  it("isolates prefs between two accounts", async () => {
    const aCookie = await signup("hank", "password123", "203.0.113.10");
    const bCookie = await signup("iris", "password123", "203.0.113.11");
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

  it("stream path returns 412 as a clean JSON body BEFORE the event-stream opens", async () => {
    const cookie = await signup("jade", "password123");
    const res = await req("/api/chat/stream", {
      method: "POST",
      cookie,
      body: { model: STREAM_CHAT, user_input: "hi" },
    });
    expect(res.status).toBe(412);
    // The refusal is a JSON body, not a text/event-stream that already opened.
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("gateway_not_configured");
  });

  it("source is never worker/mixed in public mode even with worker secrets present", async () => {
    anyEnv.GATEWAY_ID = "host-gateway";
    anyEnv.CF_AIG_TOKEN = "host-token";
    const cookie = await signup("kate", "password123");
    const b = await boot(cookie);
    expect(b.gateway.source).toBe("none");
    expect(b.gateway.configured).toBe(false);
  });

  it("positive control: once the user sets account id + gateway + token, the 412 no longer fires", async () => {
    const cookie = await signup("liam", "password123");
    await req("/api/prefs", {
      method: "PATCH",
      cookie,
      body: { account_id: USER_ACCT, gateway_id: "liam-gw", cf_aig_token: "liam-token" },
    });
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

// prism#193: OPENAI_API_KEY is a deployer secret, so in public mode it must be
// ignored exactly like GATEWAY_ID / CF_AIG_TOKEN. The user here has a fully
// configured BYOK gateway so the credential gate passes and the request reaches
// the image dispatch branch; the only question is which transport it picks.
describe("OPENAI_API_KEY is ignored in public mode (prism#193)", () => {
  const GPT_IMAGE = MODELS.find((m) => m.type === "image" && m.provider === "openai")!.id;
  const keyEnv = env as unknown as { OPENAI_API_KEY?: string };
  const realFetch = globalThis.fetch;
  let openaiCalls: string[];

  beforeEach(() => {
    openaiCalls = [];
    keyEnv.OPENAI_API_KEY = "sk-host-owned";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://api.openai.com/")) {
        openaiCalls.push(url);
        return new Response(JSON.stringify({ error: { message: "stubbed" } }), { status: 500 });
      }
      // v1.1.0: an account-scoped user dispatches over REST to their own
      // account; answer it locally so the test never leaves the sandbox.
      if (url.startsWith("https://api.cloudflare.com/")) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: "stubbed" }] }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    delete keyEnv.OPENAI_API_KEY;
    globalThis.fetch = realFetch;
  });

  async function runGptImage(headers: Record<string, string>): Promise<void> {
    const h = new Headers({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.40", ...headers });
    await SELF.fetch("https://prism.test/api/prefs", {
      method: "PATCH",
      headers: h,
      // v1.1.0: account id included, or public mode would 412 before the
      // image branch and this test would pass without testing anything.
      body: JSON.stringify({ account_id: USER_ACCT, gateway_id: "user-gw", cf_aig_token: "user-token" }),
    });
    try {
      await SELF.fetch("https://prism.test/api/chat", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ model: GPT_IMAGE, user_input: "a red kite" }),
      });
    } catch {
      // The inert AI stub makes the gateway path throw; that is fine, the
      // assertion is only about whether api.openai.com was dialed.
    }
  }

  it("public mode: a configured user's gpt-image request never dials api.openai.com with the host key", async () => {
    const cookie = await signup("olga", "password123");
    await runGptImage({ cookie });
    expect(openaiCalls).toEqual([]);
  });

  it("positive control: access mode still uses the deployer key (the stub can see the call)", async () => {
    anyEnv.AUTH_MODE = "access";
    await runGptImage({ "cf-access-authenticated-user-email": "owner@example.com" });
    expect(openaiCalls.length).toBe(1);
  });
});

// v1.1.0: BYOK must reach the user's own Cloudflare account. The AI binding is
// pinned to the worker's account, so these assert (1) the pre-v1.1.0 shape is
// refused with its own code rather than resolved on our binding, and (2) a
// fully configured user is dispatched over HTTP to THEIR account id. The AI
// stub here is an inert {}: any path that touched the host binding would throw,
// so a 200 with stubbed fetch proves the binding was never used.
describe("account-scoped BYOK (v1.1.0)", () => {
  const LEGACY_ANTHROPIC = MODELS.find((m) => m.provider === "anthropic" && !m.binding)!.id;
  const BINDING_ANTHROPIC = MODELS.find((m) => m.provider === "anthropic" && m.binding)!.id;
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; headers: Headers; body: string }>;

  const anthropicMessage = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "stub",
    content: [{ type: "text", text: "hello from your account" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 5 },
  };

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://gateway.ai.cloudflare.com/") || url.startsWith("https://api.cloudflare.com/")) {
        calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
        const payload = url.startsWith("https://api.cloudflare.com/")
          ? { success: true, errors: [], result: anthropicMessage }
          : anthropicMessage;
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json", "cf-aig-log-id": "user-log-1" },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function configure(cookie: string, body: Record<string, unknown>): Promise<Response> {
    return req("/api/prefs", { method: "PATCH", cookie, body });
  }

  it("pre-v1.1.0 shape (slug + token, no account id): 412 gateway_account_id_required, nothing dialed", async () => {
    const cookie = await signup("petra", "password123");
    await configure(cookie, { gateway_id: "petra-gw", cf_aig_token: "petra-token" });
    for (const model of [LEGACY_ANTHROPIC, BINDING_ANTHROPIC, WORKERS_AI_CHAT]) {
      const res = await req("/api/chat", { method: "POST", cookie, body: { model, user_input: "hi" } });
      expect(res.status).toBe(412);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("gateway_account_id_required");
      expect(body.error).toMatch(/account ID/);
    }
    expect(calls).toEqual([]);
  });

  it("boot and prefs flag the pre-v1.1.0 user and keep their saved slug", async () => {
    const cookie = await signup("quinn", "password123");
    await configure(cookie, { gateway_id: "quinn-gw", cf_aig_token: "quinn-token" });
    const b = (await boot(cookie)) as BootEnvelope & {
      gateway: { account_id_required: boolean; gateway_id: string | null };
    };
    expect(b.gateway.configured).toBe(false);
    expect(b.gateway.account_id_required).toBe(true);
    expect(b.gateway.gateway_id).toBe("quinn-gw");

    // Adding only the account id completes the migration.
    const res = await configure(cookie, { account_id: USER_ACCT.toUpperCase() });
    expect(res.status).toBe(200);
    const prefs = (await res.json()) as { configured: boolean; account_id: string; account_id_required: boolean };
    expect(prefs.configured).toBe(true);
    expect(prefs.account_id).toBe(USER_ACCT); // normalized to lowercase
    expect(prefs.account_id_required).toBe(false);
  });

  it("rejects a malformed account id or gateway slug with 400", async () => {
    const cookie = await signup("rhea", "password123");
    const badAcct = await configure(cookie, { account_id: "not-an-account" });
    expect(badAcct.status).toBe(400);
    expect(((await badAcct.json()) as { code: string }).code).toBe("invalid_account_id");
    const badGw = await configure(cookie, { gateway_id: "../other-gw" });
    expect(badGw.status).toBe(400);
    expect(((await badGw.json()) as { code: string }).code).toBe("invalid_gateway_id");
  });

  it("account id without a token: 412 cf_aig_token_required", async () => {
    const cookie = await signup("sven", "password123");
    await configure(cookie, { account_id: USER_ACCT, gateway_id: "sven-gw" });
    const res = await req("/api/chat", { method: "POST", cookie, body: { model: WORKERS_AI_CHAT, user_input: "hi" } });
    expect(res.status).toBe(412);
    expect(((await res.json()) as { code: string }).code).toBe("cf_aig_token_required");
  });

  it("legacy provider path dials gateway.ai.cloudflare.com under the USER's account id", async () => {
    const cookie = await signup("tara", "password123");
    await configure(cookie, { account_id: USER_ACCT, gateway_id: "tara-gw", cf_aig_token: "tara-token" });
    const res = await req("/api/chat", { method: "POST", cookie, body: { model: LEGACY_ANTHROPIC, user_input: "hi" } });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://gateway.ai.cloudflare.com/v1/${USER_ACCT}/tara-gw/anthropic/v1/messages`);
    expect(calls[0].headers.get("cf-aig-authorization")).toBe("Bearer tara-token");
    expect(calls[0].headers.get("x-api-key")).toBeNull();
  });

  it("binding-catalog path goes to the USER's account over REST, never the host binding", async () => {
    const cookie = await signup("uma", "password123");
    await configure(cookie, { account_id: USER_ACCT, gateway_id: "uma-gw", cf_aig_token: "uma-token" });
    const res = await req("/api/chat", { method: "POST", cookie, body: { model: BINDING_ANTHROPIC, user_input: "hi" } });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${USER_ACCT}/ai/run`);
    expect(calls[0].headers.get("authorization")).toBe("Bearer uma-token");
    expect(calls[0].headers.get("cf-aig-gateway-id")).toBe("uma-gw");
    expect((JSON.parse(calls[0].body) as { model: string }).model).toBe(BINDING_ANTHROPIC);
  });

  it("Workers AI chat through aiRun also bills the USER's account (model-in-path)", async () => {
    const cookie = await signup("vera", "password123");
    await configure(cookie, { account_id: USER_ACCT, gateway_id: "vera-gw", cf_aig_token: "vera-token" });
    await req("/api/chat", { method: "POST", cookie, body: { model: WORKERS_AI_CHAT, user_input: "hi" } });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${USER_ACCT}/ai/run/${WORKERS_AI_CHAT}`);
    expect(calls[0].headers.get("cf-aig-gateway-id")).toBe("vera-gw");
  });
});

describe("DELETE /api/account cascade", () => {
  it("requires password re-entry and cascades the account's data", async () => {
    const cookie = await signup("mona", "password123");
    const userId = (
      await env.DB.prepare(`SELECT id FROM users WHERE username_lc = 'mona'`).first<{ id: string }>()
    )!.id;

    await env.DB.prepare(
      `INSERT INTO chats (user_email, model, model_type, user_input, output, output_artifact)
       VALUES (?, 'm', 'image', 'hi', '', ?)`,
    )
      .bind(userId, JSON.stringify({ key: "out/mona.png", mime: "image/png", type: "image" }))
      .run();
    await env.R2.put("out/mona.png", new Uint8Array([1, 2, 3]), { customMetadata: { user_email: userId } });
    await req("/api/prefs", { method: "PATCH", cookie, body: { gateway_id: "mona-gw" } });

    const otherCookie = await signup("nell", "password123", "203.0.113.20");
    const otherId = (
      await env.DB.prepare(`SELECT id FROM users WHERE username_lc = 'nell'`).first<{ id: string }>()
    )!.id;

    const bad = await req("/api/account", { method: "DELETE", cookie, body: { password: "nope" } });
    expect(bad.status).toBe(403);

    const del = await req("/api/account", { method: "DELETE", cookie, body: { password: "password123" } });
    expect(del.status).toBe(200);
    expect(del.headers.get("set-cookie")).toContain("Max-Age=0");

    expect(await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first()).toBeNull();
    for (const [table, col] of [["chats", "user_email"], ["user_prefs", "user_email"], ["sessions", "user_id"]] as const) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(userId).first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
    expect(await env.R2.get("out/mona.png")).toBeNull();

    // The other account is untouched.
    expect(await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(otherId).first()).not.toBeNull();
    expect((await boot(otherCookie)).authenticated).toBe(true);
  });
});

describe("login rate limit resets on success", () => {
  it("successful logins beyond the failed cap never lock out, and clear the bucket", async () => {
    await signup("pia", "password123", "198.51.100.9");
    // More than LOGIN_LIMIT (5) SUCCESSFUL logins in one window must all pass.
    for (let i = 0; i < 7; i++) {
      const res = await req("/api/auth/login", {
        method: "POST",
        body: { username: "pia", password: "password123" },
        ip: "198.51.100.9",
      });
      expect(res.status).toBe(200);
    }
    // Bucket is cleared after a success (not left accumulating).
    const row = await env.DB.prepare(`SELECT count FROM auth_attempts WHERE bucket_key = ?`)
      .bind("login:198.51.100.9:pia")
      .first<{ count: number }>();
    expect(row).toBeNull();
  });

  it("a burst of failures still locks out, then a later success would reset it", async () => {
    await signup("quinn", "password123", "198.51.100.12");
    let locked = false;
    for (let i = 0; i < 8; i++) {
      const res = await req("/api/auth/login", {
        method: "POST",
        body: { username: "quinn", password: "wrongpassword" },
        ip: "198.51.100.12",
      });
      if (res.status === 429) { locked = true; break; }
    }
    expect(locked).toBe(true); // failures alone still trip the limiter
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
    const row = await env.DB.prepare(`SELECT count FROM auth_attempts WHERE bucket_key = ?`)
      .bind("login:198.51.100.5:olive")
      .first<{ count: number }>();
    expect(row).not.toBeNull();
    expect(row!.count).toBeGreaterThanOrEqual(5);
  });
});
