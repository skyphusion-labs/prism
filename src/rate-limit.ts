// Signup/login rate limiting (v0.167.0, issue #80).
//
// A D1 counter per bucket key (e.g. "login:<ip>:<username>" or "signup:<ip>"),
// windowed. Zero new binding, transactional with the auth store; Turnstile / WAF
// are documented follow-ons, not first-cut blockers. The window decision is a
// pure function so it is unit-testable without D1; the DB layer only does the
// epoch conversion and the upsert.

export interface RateLimitDecision {
  allowed: boolean;
  nextCount: number;
  nextWindowStart: number; // epoch seconds
}

// Sliding fixed-window decision. A fresh window (no prior record, or the prior
// window has fully elapsed) resets the count to 1 and always allows. Within a
// live window the count increments and the attempt is allowed only while the
// post-increment count stays within the limit. Denied attempts still count, so
// sustained pressure keeps the bucket closed until the window rolls over.
export function rateLimitDecision(
  nowSec: number,
  windowStartSec: number | null,
  count: number,
  limit: number,
  windowSeconds: number,
): RateLimitDecision {
  if (windowStartSec === null || nowSec - windowStartSec >= windowSeconds) {
    return { allowed: true, nextCount: 1, nextWindowStart: nowSec };
  }
  const nextCount = count + 1;
  return { allowed: nextCount <= limit, nextCount, nextWindowStart: windowStartSec };
}

// Record an attempt against a bucket and report whether it is allowed. Every
// call is one attempt; the caller should invoke this exactly once per
// signup/login try, before doing the expensive work.
export async function checkRateLimit(
  db: D1Database,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT count, CAST(strftime('%s', window_start) AS INTEGER) AS ws
         FROM auth_attempts WHERE bucket_key = ?`,
    )
    .bind(bucketKey)
    .first<{ count: number; ws: number }>();
  const nowRow = await db
    .prepare(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now`)
    .first<{ now: number }>();
  const now = nowRow?.now ?? 0;

  const decision = rateLimitDecision(now, row?.ws ?? null, row?.count ?? 0, limit, windowSeconds);

  await db
    .prepare(
      `INSERT INTO auth_attempts (bucket_key, count, window_start)
       VALUES (?, ?, datetime(?, 'unixepoch'))
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = excluded.count,
         window_start = excluded.window_start`,
    )
    .bind(bucketKey, decision.nextCount, decision.nextWindowStart)
    .run();

  return decision.allowed;
}

// Clear a bucket outright. Used to reset the login limiter on a SUCCESSFUL
// login so that successful sign-ins never count toward the failed-attempt cap
// (the check stays pre-verify to throttle the flood case; success just wipes
// the tally).
export async function resetRateLimit(db: D1Database, bucketKey: string): Promise<void> {
  await db.prepare(`DELETE FROM auth_attempts WHERE bucket_key = ?`).bind(bucketKey).run();
}
