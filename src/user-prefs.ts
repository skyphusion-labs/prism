// Per-user preferences stored in D1 (v0.164.0).
//
// JSON blob keyed by the caller's identity (Access email or public account
// id). Gateway fields are the first use case for a public demo deployment
// where each visitor brings their own AI Gateway.
//
// v1.1.0: account_id added. Being a key in the JSON blob, it needs no DDL;
// pre-v1.1.0 rows simply lack it and resolve as "account id required" in
// public mode (see resolveGateway in gateway-credentials.ts).

export interface UserPrefsJson {
  /** v1.1.0: Cloudflare account id (32 hex) that owns gateway_id. */
  account_id?: string;
  gateway_id?: string;
  cf_aig_token?: string;
  /**
   * When set, chat bills through prism-control-plane (allowlisted origin from
   * worker config, never a user-supplied URL -- SSRF). Client key `pcp_…`.
   */
  control_plane_key?: string;
}

function parsePrefsJson(raw: string | null | undefined): UserPrefsJson {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as UserPrefsJson;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export async function loadUserPrefs(db: D1Database, userEmail: string): Promise<UserPrefsJson | null> {
  const row = await db.prepare(
    `SELECT prefs_json FROM user_prefs WHERE user_email = ?`,
  )
    .bind(userEmail)
    .first<{ prefs_json: string }>();
  if (!row) return null;
  return parsePrefsJson(row.prefs_json);
}

export async function saveUserPrefs(
  db: D1Database,
  userEmail: string,
  patch: UserPrefsJson,
): Promise<UserPrefsJson> {
  const existing = (await loadUserPrefs(db, userEmail)) ?? {};
  const merged: UserPrefsJson = { ...existing };

  if (patch.account_id !== undefined) {
    // Callers validate before saving; stored lowercase so comparisons and
    // the URL builder see one canonical form.
    const trimmed = patch.account_id.trim().toLowerCase();
    if (trimmed) merged.account_id = trimmed;
    else delete merged.account_id;
  }
  if (patch.gateway_id !== undefined) {
    const trimmed = patch.gateway_id.trim();
    if (trimmed) merged.gateway_id = trimmed;
    else delete merged.gateway_id;
  }
  if (patch.cf_aig_token !== undefined) {
    const trimmed = patch.cf_aig_token.trim();
    if (trimmed) merged.cf_aig_token = trimmed;
    else delete merged.cf_aig_token;
  }
  if (patch.control_plane_key !== undefined) {
    const trimmed = patch.control_plane_key.trim();
    if (trimmed) merged.control_plane_key = trimmed;
    else delete merged.control_plane_key;
  }

  await db.prepare(
    `INSERT INTO user_prefs (user_email, prefs_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_email) DO UPDATE SET
       prefs_json = excluded.prefs_json,
       updated_at = excluded.updated_at`,
  )
    .bind(userEmail, JSON.stringify(merged))
    .run();

  return merged;
}
