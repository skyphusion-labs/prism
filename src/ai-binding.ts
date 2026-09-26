// env.AI binding wrappers (v0.19.3; per-user gateway v0.164.0; account-scoped
// REST transport v1.1.0).
//
// Extracted from src/index.ts so provider modules and other code paths that
// call env.AI.run share one binding wrapper rather than each constructing its
// own opts object.
//
// `aiRun` is the standard call path: pass model, params, optional flag to
// return the raw Response (rather than a parsed object) for binary-output
// models like TTS.
//
// `aiLogId` reads the Cloudflare AI Gateway log ID after a call, when one
// exists.
//
// v1.1.0: two transports, chosen by the credentials, never by the model.
//   - accountId null: env.AI.run on this worker's binding. Cloudflare pins the
//     binding's gateway to the worker's own account and pre-authenticates it,
//     so this bills the deployer. Access mode (private self-host) only.
//   - accountId set: POST api.cloudflare.com/client/v4/accounts/{account}/ai/run
//     with the user's token and cf-aig-gateway-id, which bills the user's
//     account. This is the only way to reach another account's gateway; the
//     binding cannot, whatever gateway id it is handed.
// `gatewayProviderUrl` applies the same split to the provider-native
// gateway.ai.cloudflare.com endpoints (legacy Anthropic / xAI paths).

import type { Env } from "./env";
import type { GatewayCredentials } from "./gateway-credentials";
import { base64ToBytes } from "./utils";

export interface AiContext {
  env: Env;
  gateway: GatewayCredentials;
  /** v1.1.0: cf-aig-log-id from the last REST call (the binding tracks its own). */
  lastLogId?: string | null;
}

type RunOpts = { gateway: { id: string }; returnRawResponse?: boolean };
type RunFn = (model: string, params: unknown, opts?: RunOpts) => Promise<unknown>;

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const AI_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1";

export function aiRun(ctx: AiContext, model: string, params: unknown, returnRaw = false): Promise<unknown> {
  if (ctx.gateway.accountId) return restRun(ctx, ctx.gateway.accountId, model, params, returnRaw);
  const opts: RunOpts = { gateway: { id: ctx.gateway.gatewayId } };
  if (returnRaw) opts.returnRawResponse = true;
  return (ctx.env.AI as unknown as { run: RunFn }).run(model, params, opts);
}

export function aiLogId(ctx: AiContext): string | null {
  // An account-scoped context never reads the binding: its log id belongs to
  // whatever the binding last did on OUR account, not to this call.
  if (ctx.gateway.accountId) return ctx.lastLogId ?? null;
  return (ctx.env.AI as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;
}

/**
 * Base URL of a provider-native AI Gateway endpoint
 * (https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}).
 * Account-scoped credentials build it from the user's account; otherwise the
 * binding's getUrl supplies this worker's own account.
 */
export async function gatewayProviderUrl(ctx: AiContext, provider: string): Promise<string> {
  const { accountId, gatewayId } = ctx.gateway;
  if (accountId) {
    return `${AI_GATEWAY_BASE}/${accountId}/${encodeURIComponent(gatewayId)}/${provider}`;
  }
  return (ctx.env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(gatewayId).getUrl(provider);
}

// Workers AI (@cf/) models use the model-in-path endpoint, the one Cloudflare
// documents for billing @cf calls to the gateway's credits; partner models use
// the /ai/run envelope ({ model, input }). Both take cf-aig-gateway-id.
export function buildRestRunRequest(
  accountId: string,
  gateway: GatewayCredentials,
  model: string,
  params: unknown,
): { url: string; init: RequestInit } {
  const base = `${CF_API_BASE}/accounts/${accountId}/ai/run`;
  const isWorkersAi = model.startsWith("@cf/");
  return {
    url: isWorkersAi ? `${base}/${model}` : base,
    init: {
      method: "POST",
      headers: {
        "authorization": `Bearer ${gateway.cfAigToken}`,
        "cf-aig-gateway-id": gateway.gatewayId,
        "content-type": "application/json",
      },
      body: JSON.stringify(isWorkersAi ? params : { model, input: params }),
    },
  };
}

async function restRun(
  ctx: AiContext,
  accountId: string,
  model: string,
  params: unknown,
  returnRaw: boolean,
): Promise<unknown> {
  const { url, init } = buildRestRunRequest(accountId, ctx.gateway, model, params);
  const resp = await fetch(url, init);
  ctx.lastLogId = resp.headers.get("cf-aig-log-id");
  return unwrapRestResponse(resp, accountId, returnRaw);
}

// Normalizes a REST response to what the binding would have returned, so no
// caller has to know which transport ran:
//   - JSON: unwrap the Cloudflare API envelope ({ success, result, errors }).
//   - SSE / binary: the body stream (the binding returns a ReadableStream).
//   - returnRaw: a Response carrying the bytes (TTS reads arrayBuffer()).
export async function unwrapRestResponse(resp: Response, accountId: string, returnRaw: boolean): Promise<unknown> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ code?: number; message?: string }> };
      if (parsed.errors?.length) {
        detail = parsed.errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
      }
    } catch { /* non-JSON error body; keep the text */ }
    let hint = "";
    if (resp.status === 401 || resp.status === 403) {
      hint = ` Check that your API token has Workers AI Read and AI Gateway Run on account ${accountId}.`;
    }
    throw new Error(`Cloudflare AI (your account) ${resp.status}: ${detail || resp.statusText}.${hint}`);
  }

  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const body = await resp.json() as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
    let unwrapped: unknown = body;
    if (body && typeof body === "object" && typeof body.success === "boolean") {
      if (!body.success) {
        const msg = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || "request failed";
        throw new Error(`Cloudflare AI (your account): ${msg}`);
      }
      unwrapped = body.result;
    }
    if (!returnRaw) return unwrapped;
    // Raw callers want bytes. Some TTS models answer JSON { audio: base64 }.
    const audio = (unwrapped as { audio?: unknown } | null)?.audio;
    if (typeof audio === "string") {
      return new Response(base64ToBytes(audio), { headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error("Cloudflare AI (your account): expected binary output, got JSON without an audio field");
  }

  if (returnRaw) return resp;
  return resp.body;
}
