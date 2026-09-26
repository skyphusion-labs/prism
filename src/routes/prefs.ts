// Per-user AI Gateway preference routes (GET/PATCH /api/prefs). Stores the
// user's Cloudflare account id (v1.1.0), gateway slug, and Unified Billing
// token in D1 user_prefs; the token is never echoed back raw (maskSecret). Optional control_plane_key (pcp_) for
// metered chat via allowlisted play-proxy (URL is never user-set).

import type { Env } from "../env";
import { loadUserPrefs, saveUserPrefs, type UserPrefsJson } from "../user-prefs";
import {
  isValidGatewayId,
  loadGatewayStatus,
  maskSecret,
  normalizeAccountId,
} from "../gateway-credentials";
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

export async function handlePrefsGet(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const prefs = await loadUserPrefs(env.DB, userEmail);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    account_id: status.account_id,
    account_id_required: status.account_id_required,
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
    account_id?: string;
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
  if (body.account_id !== undefined) {
    if (typeof body.account_id !== "string") {
      return json({ error: "account_id must be a string", code: "invalid_account_id" }, { status: 400 });
    }
    // Empty clears it; anything else must be a real account id, since it
    // becomes a path segment in every request we send on the user's behalf.
    if (body.account_id.trim() && !normalizeAccountId(body.account_id)) {
      return json(
        {
          error: "account_id must be your 32-character Cloudflare account ID (hex), from the Cloudflare dashboard.",
          code: "invalid_account_id",
        },
        { status: 400 },
      );
    }
    patch.account_id = body.account_id;
  }
  if (body.gateway_id !== undefined) {
    if (typeof body.gateway_id !== "string") {
      return json({ error: "gateway_id must be a string", code: "invalid_gateway_id" }, { status: 400 });
    }
    if (body.gateway_id.trim() && !isValidGatewayId(body.gateway_id)) {
      return json(
        {
          error: "gateway_id must be your AI Gateway slug: letters, digits, '-' or '_', up to 64 characters.",
          code: "invalid_gateway_id",
        },
        { status: 400 },
      );
    }
    patch.gateway_id = body.gateway_id;
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
        error: "Provide account_id, gateway_id, cf_aig_token, and/or control_plane_key to update",
      },
      { status: 400 },
    );
  }

  const merged = await saveUserPrefs(env.DB, userEmail, patch);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    account_id: status.account_id,
    account_id_required: status.account_id_required,
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(merged.cf_aig_token),
    configured: status.configured || !!resolveControlPlane(merged, env),
    source: status.source,
    ...controlPlaneStatus(merged, env),
  });
}
