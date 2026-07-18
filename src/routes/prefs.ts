// Per-user AI Gateway preference routes (GET/PATCH /api/prefs). Stores the
// user gateway slug + Unified Billing token in D1 user_prefs; the token is
// never echoed back raw (maskSecret).

import type { Env } from "../env";
import { loadUserPrefs, saveUserPrefs } from "../user-prefs";
import { loadGatewayStatus, maskSecret } from "../gateway-credentials";
import { json, getUserEmail } from "./shared";

export async function handlePrefsGet(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const prefs = await loadUserPrefs(env.DB, userEmail);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(prefs?.cf_aig_token),
    configured: status.configured,
    source: status.source,
  });
}

export async function handlePrefsPatch(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  let body: { gateway_id?: string; cf_aig_token?: string; clear_cf_aig_token?: boolean };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: { gateway_id?: string; cf_aig_token?: string } = {};
  if (body.gateway_id !== undefined) patch.gateway_id = body.gateway_id;
  if (body.cf_aig_token !== undefined) patch.cf_aig_token = body.cf_aig_token;
  if (body.clear_cf_aig_token) patch.cf_aig_token = "";

  if (Object.keys(patch).length === 0) {
    return json({ error: "Provide gateway_id and/or cf_aig_token to update" }, { status: 400 });
  }

  const merged = await saveUserPrefs(env.DB, userEmail, patch);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(merged.cf_aig_token),
    configured: status.configured,
    source: status.source,
  });
}

