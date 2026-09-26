// Per-user AI Gateway preference routes (GET/PATCH /api/prefs). Stores the
// user gateway slug + Unified Billing token in D1 user_prefs; the token is
// never echoed back raw (maskSecret). Optional control_plane_key (pcp_) for
// metered chat via allowlisted play-proxy (URL is never user-set).

import type { Env } from "../env";
import { loadUserPrefs, saveUserPrefs, type UserPrefsJson } from "../user-prefs";
import { loadGatewayStatus, maskSecret } from "../gateway-credentials";
import {
  DEFAULT_CONTROL_PLANE_URL,
  looksLikeClientKey,
  resolveControlPlane,
} from "../control-plane";
import { json, getUserEmail } from "./shared";

function controlPlaneStatus(prefs: UserPrefsJson | null, env: Env) {
  const cp = resolveControlPlane(prefs, env);
  return {
    control_plane_configured: !!cp,
    // Display-only origin (from worker config / default); not editable by the user.
    control_plane_url: cp?.baseUrl ?? DEFAULT_CONTROL_PLANE_URL,
    control_plane_key_set: !!prefs?.control_plane_key?.trim(),
    control_plane_key_preview: maskSecret(prefs?.control_plane_key),
  };
}

// The saved slug becomes a path segment in a gateway.ai.cloudflare.com URL and a
// request header value, so it is validated on WRITE rather than at every read.
// Same shape prism-control-plane already enforces on its own slug field; prism
// applied only .trim(), which is not a constraint on a value used that way.
const GATEWAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function handlePrefsGet(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const prefs = await loadUserPrefs(env.DB, userEmail);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(prefs?.cf_aig_token),
    configured: status.configured || !!resolveControlPlane(prefs, env),
    source: status.source,
    ...controlPlaneStatus(prefs, env),
  });
}

export async function handlePrefsPatch(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  let body: {
    gateway_id?: string;
    cf_aig_token?: string;
    clear_cf_aig_token?: boolean;
    control_plane_key?: string;
    clear_control_plane_key?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: UserPrefsJson = {};
  if (body.gateway_id !== undefined) {
    const g = String(body.gateway_id).trim();
    if (g && !GATEWAY_ID_RE.test(g)) {
      return json(
        {
          error:
            "gateway_id must be 1 to 64 characters of letters, digits, hyphen or underscore.",
          code: "invalid_gateway_id",
        },
        { status: 400 },
      );
    }
    patch.gateway_id = g;
  }
  if (body.cf_aig_token !== undefined) patch.cf_aig_token = body.cf_aig_token;
  if (body.clear_cf_aig_token) patch.cf_aig_token = "";
  if (body.control_plane_key !== undefined) {
    const k = body.control_plane_key.trim();
    if (k && !looksLikeClientKey(k)) {
      return json(
        {
          error:
            "control_plane_key must be a prism-control-plane client key (pcp_<16 hex>_<43 base64url>).",
          code: "invalid_control_plane_key",
        },
        { status: 400 },
      );
    }
    patch.control_plane_key = k;
  }
  if (body.clear_control_plane_key) patch.control_plane_key = "";

  if (Object.keys(patch).length === 0) {
    return json(
      {
        error: "Provide gateway_id, cf_aig_token, and/or control_plane_key to update",
      },
      { status: 400 },
    );
  }

  const merged = await saveUserPrefs(env.DB, userEmail, patch);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(merged.cf_aig_token),
    configured: status.configured || !!resolveControlPlane(merged, env),
    source: status.source,
    ...controlPlaneStatus(merged, env),
  });
}
