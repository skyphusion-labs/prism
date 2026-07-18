// Per-user AI Gateway credentials (v0.164.0).
//
// Supports two deployment modes:
//   - Deployer secrets: GATEWAY_ID + CF_AIG_TOKEN on the worker (private install)
//   - Public demo: no worker secrets; each user stores their own gateway slug
//     and Cloudflare API token in D1 user_prefs (Unified Billing on their dime)
//
// Resolution merges user prefs over worker secrets field-by-field so a partial
// override still falls back to deployer defaults where unset.
//
// v0.167.0 (issue #80): when AUTH_MODE=public the worker secrets are ignored
// entirely (fail closed). A public deploy must never bill the host for visitor
// inference, so even a mistakenly-present GATEWAY_ID / CF_AIG_TOKEN is treated
// as absent: source is only ever "user" or "none", never "worker"/"mixed".

import type { Env } from "./env";
import { loadUserPrefs, type UserPrefsJson } from "./user-prefs";

export interface GatewayCredentials {
  gatewayId: string;
  cfAigToken: string;
}

export type GatewaySource = "user" | "worker" | "mixed" | "none";

export interface GatewayStatus {
  configured: boolean;
  source: GatewaySource;
  gateway_id: string | null;
  cf_aig_token_set: boolean;
}

export const GATEWAY_NOT_CONFIGURED_MSG =
  "AI Gateway not configured. Open Account > AI Gateway and enter your gateway slug plus a Cloudflare API token with AI Gateway Run permission. Unified Billing charges your Cloudflare account.";

export const CF_AIG_TOKEN_REQUIRED_MSG =
  "This model requires a Cloudflare API token with AI Gateway Run permission. Add it under Account > AI Gateway.";

// True when this deployment is the public product; worker gateway secrets are
// then off-limits for billing resolution.
function isPublic(env: Env): boolean {
  return env.AUTH_MODE === "public";
}

export function resolveGatewayFromParts(
  prefs: UserPrefsJson | null,
  env: Env,
): GatewayCredentials | null {
  // Public mode: user prefs only, no worker-secret fallback (fail closed).
  const workerGateway = isPublic(env) ? "" : (env.GATEWAY_ID?.trim() || "");
  const workerToken = isPublic(env) ? "" : (env.CF_AIG_TOKEN?.trim() || "");
  const gatewayId = (prefs?.gateway_id?.trim() || workerGateway);
  const cfAigToken = (prefs?.cf_aig_token?.trim() || workerToken);
  if (!gatewayId) return null;
  return { gatewayId, cfAigToken };
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

export async function loadGatewayCredentials(
  env: Env,
  userEmail: string,
): Promise<GatewayCredentials | null> {
  const prefs = await loadUserPrefs(env.DB, userEmail);
  return resolveGatewayFromParts(prefs, env);
}

export async function loadGatewayStatus(env: Env, userEmail: string): Promise<GatewayStatus> {
  const prefs = await loadUserPrefs(env.DB, userEmail);
  const resolved = resolveGatewayFromParts(prefs, env);
  return {
    configured: !!resolved?.gatewayId,
    source: gatewaySource(prefs, env),
    gateway_id: resolved?.gatewayId ?? null,
    cf_aig_token_set: !!(resolved?.cfAigToken),
  };
}

export function maskSecret(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  if (v.length <= 8) return "••••";
  return `${"•".repeat(Math.min(12, v.length - 4))}${v.slice(-4)}`;
}
