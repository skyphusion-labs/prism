// First-party auth plane for the public deployment (v0.167.0, issue #80).
//
// Two deployment modes, selected by env.AUTH_MODE:
//   - "access" (default when unset): Cloudflare Access sits in front and the
//     worker trusts Cf-Access-Authenticated-User-Email. This is the private
//     self-host path and preserves all pre-v0.167.0 behavior.
//   - "public": no Access. Visitors sign up with username + password; identity
//     comes from an httpOnly session cookie. Gateway credentials are per-user
//     only (fail closed), so visitor inference never bills the host.
//
// Identity is derived in exactly one place, resolveIdentity(), which both read
// sites call (src/index.ts getUserEmail and src/stt-session.ts), so the two can
// never diverge. The returned string is the ownership key written to every
// user_email-keyed row and R2 customMetadata; in public mode it is the opaque
// users.id, in access mode the Access email, in local dev "anonymous".

import type { Env } from "./env";
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from "./auth-kdf";
import {
  SESSION_COOKIE,
  buildSessionCookie,
  clearSessionCookie,
  createSession,
  deleteAllUserSessions,
  deleteSession,
  lookupSession,
  parseSessionCookie,
} from "./session";
import { checkRateLimit, resetRateLimit } from "./rate-limit";

export type AuthMode = "public" | "access";

export function authMode(env: Env): AuthMode {
  return env.AUTH_MODE === "public" ? "public" : "access";
}

const ANON = "anonymous";

// Per-request memo so the boot gate and the handler that follows resolve the
// session at most once against D1. Keyed by the Request object, which the
// router threads unchanged into every handler.
const identityMemo = new WeakMap<Request, string | null>();

// The single identity derivation. Returns the ownership key, or null when the
// request is unauthenticated in public mode (no/invalid session). Access mode
// never returns null: an absent header falls back to the anonymous local-dev
// identity, exactly as before.
export async function resolveIdentity(request: Request, env: Env): Promise<string | null> {
  if (identityMemo.has(request)) return identityMemo.get(request) ?? null;

  let result: string | null;
  if (authMode(env) === "access") {
    result = request.headers.get("cf-access-authenticated-user-email") ?? ANON;
  } else {
    const token = parseSessionCookie(request);
    result = token ? await lookupSession(env.DB, token) : null;
  }
  identityMemo.set(request, result);
  return result;
}

// ---------- validation ----------

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 1024;

export function validateUsername(username: unknown): string | null {
  if (typeof username !== "string") return "Username is required.";
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) {
    return "Username must be 3-32 characters: letters, digits, dash, underscore.";
  }
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

// Opaque stable user id: "usr_" + 24 lowercase hex (12 random bytes).
export function generateUserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `usr_${hex}`;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

// ---------- rate-limit budgets ----------

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 15 * 60; // 15 minutes per ip+username
const SIGNUP_LIMIT = 10;
const SIGNUP_WINDOW = 60 * 60; // 10 signups per hour per ip

// Throwaway verify target for unknown usernames. Its iteration count MUST equal
// PBKDF2_ITERATIONS so that an unknown-username login costs the same wall-clock
// as a real one; otherwise the fast (low-iteration) path is a username-
// enumeration timing oracle. Built from the constant so the two can never
// drift. The salt/hash bytes are arbitrary; the compare always fails.
export const DUMMY_PASSWORD_HASH =
  `pbkdf2$sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

// ---------- routes ----------

// POST /api/auth/signup {username, password}. Public mode only. Creates the
// account, opens a session, sets the cookie. Email is deferred from v0.167.0:
// the column exists for forward-compat but the route does not accept it.
export async function handleSignup(request: Request, env: Env): Promise<Response> {
  if (authMode(env) !== "public") {
    return json({ error: "Signup is disabled on this deployment." }, { status: 403 });
  }
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const uErr = validateUsername(body.username);
  if (uErr) return json({ error: uErr }, { status: 400 });
  const pErr = validatePassword(body.password);
  if (pErr) return json({ error: pErr }, { status: 400 });

  const ip = clientIp(request);
  if (!(await checkRateLimit(env.DB, `signup:${ip}`, SIGNUP_LIMIT, SIGNUP_WINDOW))) {
    return json({ error: "Too many signups from this network. Try again later." }, { status: 429 });
  }

  const username = (body.username as string).trim();
  const usernameLc = username.toLowerCase();
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE username_lc = ?`)
    .bind(usernameLc)
    .first<{ id: string }>();
  if (existing) return json({ error: "That username is taken." }, { status: 409 });

  const id = generateUserId();
  const passwordHash = await hashPassword(body.password as string);
  await env.DB.prepare(
    `INSERT INTO users (id, username, username_lc, password_hash) VALUES (?, ?, ?, ?)`,
  )
    .bind(id, username, usernameLc, passwordHash)
    .run();

  const token = await createSession(env.DB, id);
  return json(
    { user: { username } },
    { status: 201, headers: { "set-cookie": buildSessionCookie(token) } },
  );
}

// POST /api/auth/login {username, password}. Public mode only.
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (authMode(env) !== "public") {
    return json({ error: "Login is disabled on this deployment." }, { status: 403 });
  }
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return json({ error: "Username and password are required." }, { status: 400 });
  }

  const ip = clientIp(request);
  const usernameLc = body.username.trim().toLowerCase();
  const bucketKey = `login:${ip}:${usernameLc}`;
  // Pre-verify check throttles a login flood (before the 600k-iter KDF cost).
  if (!(await checkRateLimit(env.DB, bucketKey, LOGIN_LIMIT, LOGIN_WINDOW))) {
    return json({ error: "Too many login attempts. Try again later." }, { status: 429 });
  }

  const row = await env.DB.prepare(
    `SELECT id, username, password_hash FROM users WHERE username_lc = ?`,
  )
    .bind(usernameLc)
    .first<{ id: string; username: string; password_hash: string }>();

  // Verify against the stored hash, or the equal-cost dummy when the user is
  // unknown, so a missing account and a wrong password take the same time and
  // return the same generic error (no username enumeration).
  const storedHash = row?.password_hash ?? DUMMY_PASSWORD_HASH;
  const ok = await verifyPassword(body.password, storedHash);
  if (!row || !ok) {
    return json({ error: "Invalid username or password." }, { status: 401 });
  }

  // Success: clear the failed-attempt tally so successful logins never count
  // toward the cap (the limiter targets failed floods, per the design).
  await resetRateLimit(env.DB, bucketKey);

  const token = await createSession(env.DB, row.id);
  return json(
    { user: { username: row.username } },
    { headers: { "set-cookie": buildSessionCookie(token) } },
  );
}

// POST /api/auth/logout. Drops the current session and clears the cookie.
// A no-op (still 200) when there is no session.
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = parseSessionCookie(request);
  if (token) await deleteSession(env.DB, token);
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}

// DELETE /api/account {password}. Session-authed, re-verifies the password,
// then cascades every owned artifact and row before dropping the account and
// clearing the cookie. Public mode only (access-mode identities are external).
export async function handleAccountDelete(request: Request, env: Env): Promise<Response> {
  if (authMode(env) !== "public") {
    return json({ error: "Account deletion is only available on the public deployment." }, { status: 403 });
  }
  const id = await resolveIdentity(request, env);
  if (!id) return json({ error: "Authentication required.", code: "unauthenticated" }, { status: 401 });

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.password !== "string") {
    return json({ error: "Password confirmation is required." }, { status: 400 });
  }
  const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .bind(id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.password, row.password_hash))) {
    return json({ error: "Password confirmation failed." }, { status: 403 });
  }

  await cascadeDeleteUserData(env, id);
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}

// Full account cascade. D1 has no FK enforcement, so ownership is unwound in
// application code. R2 keys are not user-prefixed, so every owned key is
// enumerated from the user's D1 rows (never an R2 list). R2 + Vectorize deletes
// are best-effort; the D1 rows are removed in a single batch so the account
// vanishes atomically even if an external delete lags.
export async function cascadeDeleteUserData(env: Env, userId: string): Promise<void> {
  // 1. R2 objects referenced by this user's chats (generated output +
  //    by-reference attachments) and documents (uploaded source bytes).
  const r2Keys = new Set<string>();
  const chatRows = await env.DB.prepare(
    `SELECT output_artifact, attachments FROM chats WHERE user_email = ?`,
  )
    .bind(userId)
    .all<{ output_artifact: string | null; attachments: string | null }>();
  for (const c of chatRows.results ?? []) {
    if (c.output_artifact) {
      try {
        const art = JSON.parse(c.output_artifact) as { key?: string };
        if (art?.key) r2Keys.add(art.key);
      } catch { /* ignore malformed */ }
    }
    if (c.attachments) {
      try {
        const atts = JSON.parse(c.attachments) as Array<{ key?: string }>;
        if (Array.isArray(atts)) for (const a of atts) if (a?.key) r2Keys.add(a.key);
      } catch { /* ignore malformed */ }
    }
  }
  const docRows = await env.DB.prepare(`SELECT r2_key FROM documents WHERE user_email = ?`)
    .bind(userId)
    .all<{ r2_key: string }>();
  for (const d of docRows.results ?? []) if (d.r2_key) r2Keys.add(d.r2_key);
  for (const key of r2Keys) {
    try { await env.R2.delete(key); } catch { /* best effort */ }
  }

  // 2. Vectorize embeddings for this user's RAG chunks.
  const vecRows = await env.DB.prepare(`SELECT vector_id FROM chunks WHERE user_email = ?`)
    .bind(userId)
    .all<{ vector_id: string }>();
  const vectorIds = (vecRows.results ?? []).map((r) => r.vector_id).filter(Boolean);
  if (vectorIds.length) {
    try { await env.VEC.deleteByIds(vectorIds); } catch { /* best effort */ }
  }

  // 3. Every D1 row keyed to this identity, in one batch. project_documents
  //    carries no user_email, so it is scoped through the user's project ids.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM project_documents WHERE project_id IN (SELECT id FROM projects WHERE user_email = ?)`,
    ).bind(userId),
    env.DB.prepare(`DELETE FROM project_messages WHERE user_email = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM chunks           WHERE user_email = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM documents        WHERE user_email = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM projects         WHERE user_email = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM chats            WHERE user_email = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM user_prefs       WHERE user_email = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM sessions         WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users            WHERE id = ?`).bind(userId),
  ]);
  // Defensive: ensure no session survives the batch (belt-and-suspenders).
  await deleteAllUserSessions(env.DB, userId);
}

export { SESSION_COOKIE };
