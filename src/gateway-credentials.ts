// Per-user AI Gateway credentials (v0.164.0).
//
// Supports two deployment modes:
//   - Deployer secrets: GATEWAY_ID + CF_AIG_TOKEN on the worker (private install)
//   - Public demo: no worker secrets; each user stores their own Cloudflare
//     account id, gateway slug, and API token in D1 user_prefs
//
// v1.1.0: before this release a user stored only slug + token, and every call
// resolved that slug on the worker's AI binding, i.e. on OUR account (the
// binding cannot address another account). A user's own gateway was
// unreachable by construction. The account id is what makes it reachable, so
// it is required before user credentials count as configured.
//
// In access mode without a user account id, resolution merges user prefs over
// worker secrets field-by-field so a partial override still falls back to
// deployer defaults where unset.
//
// v0.167.0 (issue #80): when AUTH_MODE=public the worker secrets are ignored
// entirely (fail closed). A public deploy must never bill the host for visitor
// inference, so even a mistakenly-present GATEWAY_ID / CF_AIG_TOKEN is treated
// as absent: source is only ever "user" or "none", never "worker"/"mixed".

import type { Env } from "./env";
import { resolveControlPlane } from "./control-plane";
import { loadUserPrefs, type UserPrefsJson } from "./user-prefs";

export interface GatewayCredentials {
  gatewayId: string;
  cfAigToken: string;
  /**
   * v1.1.0: the Cloudflare account that owns `gatewayId`. When set, every call
   * leaves the worker over HTTP to that account (api.cloudflare.com REST or
   * the gateway.ai.cloudflare.com provider endpoint) and bills it. When null,
   * calls ride this worker's own AI binding, which Cloudflare pins to the
   * worker's account ("Must be in the same account as your Worker"), so the
   * deployer pays. Null is only reachable in access mode; public mode refuses
   * credentials without an account id rather than fall back to ours.
   */
  accountId: string | null;
}

export type GatewaySource = "user" | "worker" | "mixed" | "none";

/** Why no usable credentials resolved; each maps to one 412 code. */
export type GatewayProblem =
  | "gateway_not_configured"
  | "gateway_account_id_required"
  | "cf_aig_token_required";

export interface GatewayResolution {
  creds: GatewayCredentials | null;
  problem: GatewayProblem | null;
}

export interface GatewayStatus {
  /**
   * True when the user can run inference: AI Gateway BYOK (gateway id) and/or
   * a control-plane pcp_ key. SPA boot (GET /api/models) uses this to hide the
   * "configure instance" banner -- pcp-only accounts must count as configured.
   */
  configured: boolean;
  source: GatewaySource;
  gateway_id: string | null;
  cf_aig_token_set: boolean;
  /** v1.1.0: stored Cloudflare account id (not a secret; it is in every gateway URL). */
  account_id: string | null;
  /**
   * v1.1.0: true for a public-mode user saved under the pre-v1.1.0 shape
   * (slug and/or token but no account id). Their calls are refused until
   * they add it; the SPA uses this to say exactly that instead of a generic
   * "not configured".
   */
  account_id_required: boolean;
  control_plane_configured: boolean;
  control_plane_key_set: boolean;
}

export const GATEWAY_NOT_CONFIGURED_MSG =
  "Inference not configured. Open Account > AI Gateway and either (1) enter your Cloudflare account ID, gateway slug, and API token (BYOK), or (2) paste a prism-control-plane client key (pcp_…) to bill chat through play-proxy.";

export const CF_AIG_TOKEN_REQUIRED_MSG =
  "This model requires a Cloudflare API token (Workers AI Read + AI Gateway Run on your account). Add it under Account > AI Gateway.";

export const GATEWAY_ACCOUNT_ID_REQUIRED_MSG =
  "Your AI Gateway settings are missing your Cloudflare account ID. Without it a gateway slug resolves on this instance's account, not yours, so model calls are refused until you add it. Open Account > AI Gateway and paste the 32-character account ID from your Cloudflare dashboard.";

export function gatewayProblemMessage(problem: GatewayProblem): string {
  switch (problem) {
    case "gateway_account_id_required": return GATEWAY_ACCOUNT_ID_REQUIRED_MSG;
    case "cf_aig_token_required": return CF_AIG_TOKEN_REQUIRED_MSG;
    default: return GATEWAY_NOT_CONFIGURED_MSG;
  }
}

// Cloudflare account ids are 32 lowercase hex characters. Normalizes case so
// a pasted uppercase id still matches; returns null for anything else.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
export function normalizeAccountId(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase() ?? "";
  return ACCOUNT_ID_RE.test(v) ? v : null;
}

// Gateway slugs become a URL path segment and a request header once they
// address a user account, so the charset is pinned at write time (and the
// URL builder still encodes it).
const GATEWAY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isValidGatewayId(raw: string): boolean {
  return GATEWAY_ID_RE.test(raw.trim());
}

// True when this deployment is the public product; worker gateway secrets are
// then off-limits for billing resolution.
function isPublic(env: Env): boolean {
  return env.AUTH_MODE === "public";
}

export function resolveGateway(prefs: UserPrefsJson | null, env: Env): GatewayResolution {
  const userGateway = prefs?.gateway_id?.trim() || "";
  const userToken = prefs?.cf_aig_token?.trim() || "";
  const accountId = normalizeAccountId(prefs?.account_id);

  // v1.1.0: account-scoped credentials are all-user. No field falls back to a
  // worker secret, because the worker's token authorizes the worker's account
  // and would be rejected by (or worse, meaningless against) the user's.
  if (accountId) {
    if (!userGateway) return { creds: null, problem: "gateway_not_configured" };
    if (!userToken) return { creds: null, problem: "cf_aig_token_required" };
    return { creds: { gatewayId: userGateway, cfAigToken: userToken, accountId }, problem: null };
  }

  // Public mode: user prefs only, no worker-secret fallback (fail closed), and
  // no account id means no route to the user's gateway. Refuse rather than
  // resolve the slug on the host binding.
  if (isPublic(env)) {
    if (userGateway || userToken) return { creds: null, problem: "gateway_account_id_required" };
    return { creds: null, problem: "gateway_not_configured" };
  }

  // Access mode (private self-host): the slug names a gateway on this
  // worker's own account and rides the binding. Deployer pays by design.
  const gatewayId = userGateway || env.GATEWAY_ID?.trim() || "";
  const cfAigToken = userToken || env.CF_AIG_TOKEN?.trim() || "";
  if (!gatewayId) return { creds: null, problem: "gateway_not_configured" };
  return { creds: { gatewayId, cfAigToken, accountId: null }, problem: null };
}

export function resolveGatewayFromParts(
  prefs: UserPrefsJson | null,
  env: Env,
): GatewayCredentials | null {
  return resolveGateway(prefs, env).creds;
}

export function gatewaySource(prefs: UserPrefsJson | null, env: Env): GatewaySource {
  const hasUserGateway = !!prefs?.gateway_id?.trim();
  const hasUserToken = !!prefs?.cf_aig_token?.trim();
  // Public mode never counts worker secrets: a public deploy resolves to
  // "user" or "none" only, so a stray worker secret cannot read as "worker".
  const hasWorkerGateway = !isPublic(env) && !!env.GATEWAY_ID?.trim();
  const hasWorkerToken = !isPublic(env) && !!env.CF_AIG_TOKEN?.trim();

  if (hasUserGateway && hasUserToken && !hasWorkerGateway && !hasWorkerToken) return "user";
  if (!hasUserGateway && !hasUserToken && hasWorkerGateway) return "worker";
  if ((hasUserGateway || hasUserToken) && (hasWorkerGateway || hasWorkerToken)) return "mixed";
  if (hasUserGateway || hasUserToken || hasWorkerGateway) return "mixed";
  return "none";
}

/**
 * Load credentials or throw the problem's user-facing message. For callers
 * outside the HTTP gate (RAG embeddings, the long-run Workflow) that surface
 * an Error rather than a 412.
 */
export async function requireGatewayCredentials(env: Env, userEmail: string): Promise<GatewayCredentials> {
  const prefs = await loadUserPrefs(env.DB, userEmail);
  const { creds, problem } = resolveGateway(prefs, env);
  if (!creds) throw new Error(gatewayProblemMessage(problem ?? "gateway_not_configured"));
  return creds;
}

/**
 * Build the UI/boot inference status from already-loaded prefs (no DB).
 * Control-plane pcp_ keys count as configured even with no gateway slug.
 */
export function buildGatewayStatus(prefs: UserPrefsJson | null, env: Env): GatewayStatus {
  const { creds, problem } = resolveGateway(prefs, env);
  const cp = resolveControlPlane(prefs, env);
  return {
    configured: !!creds || !!cp,
    source: gatewaySource(prefs, env),
    // Echo what the user saved even when it does not resolve yet, so a
    // pre-v1.1.0 user sees their slug and only has to add the account id.
    gateway_id: creds?.gatewayId ?? (prefs?.gateway_id?.trim() || null),
    cf_aig_token_set: !!(creds?.cfAigToken || prefs?.cf_aig_token?.trim()),
    account_id: normalizeAccountId(prefs?.account_id),
    account_id_required: problem === "gateway_account_id_required",
    control_plane_configured: !!cp,
    control_plane_key_set: !!prefs?.control_plane_key?.trim(),
  };
}

export async function loadGatewayStatus(env: Env, userEmail: string): Promise<GatewayStatus> {
  const prefs = await loadUserPrefs(env.DB, userEmail);
  return buildGatewayStatus(prefs, env);
}

export function maskSecret(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  if (v.length <= 8) return "••••";
  return `${"•".repeat(Math.min(12, v.length - 4))}${v.slice(-4)}`;
}
