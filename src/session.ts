// Session tokens and cookies for first-party auth (v0.167.0, issue #80).
//
// The session is an opaque 256-bit random token delivered as an httpOnly
// cookie. D1 stores only the SHA-256 hash of the token, never the raw value,
// so a leaked sessions table cannot be replayed as live cookies (same
// discipline as password hashing). This gives instant server-side revocation
// (logout and account-delete drop the row) with no JWT signing-key custody and
// no new runtime dependency.
//
// Cookie: __Host-prism_session. The __Host- prefix requires Secure + Path=/
// and forbids Domain, pinning the cookie to the exact host (no subdomain
// leak). SameSite=Lax lets the same-origin app and the same-origin STT
// WebSocket upgrade carry it while blocking cross-site POSTs (first-cut CSRF
// cover for a same-origin app).


export const SESSION_COOKIE = "__Host-prism_session";
const TOKEN_BYTES = 32;
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// base64url without padding, cookie-safe.
function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateSessionToken(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

// SHA-256 of the token, lowercase hex. This is the sessions primary key; the
// raw token exists only in the cookie.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Read our session token out of the request Cookie header. Returns null when
// absent. Tolerant of surrounding cookies and whitespace.
export function parseSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function buildSessionCookie(token: string, maxAgeSeconds: number = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// Expire the cookie immediately (logout, account delete). Same attributes as
// the set cookie so the browser matches and clears it.
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Mint a session for a user and return the raw token (to put in the cookie).
// Only the hash is persisted.
export async function createSession(
  db: D1Database,
  userId: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = await hashToken(token);
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES (?, ?, datetime('now', ?))`,
    )
    .bind(tokenHash, userId, `+${ttlSeconds} seconds`)
    .run();
  return token;
}

// Resolve a raw token to its user id, or null if unknown or expired. Expired
// rows are opportunistically deleted so the table self-prunes on access.
export async function lookupSession(db: D1Database, token: string): Promise<string | null> {
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: string }>();
  if (!row) return null;
  const expired = await db
    .prepare(`SELECT (expires_at <= datetime('now')) AS expired FROM sessions WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<{ expired: number }>();
  if (expired?.expired) {
    await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    return null;
  }
  return row.user_id;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashToken(token);
  await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function deleteAllUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
}
