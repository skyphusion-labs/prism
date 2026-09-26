// Unit tests for the account-scoped transport in src/ai-binding.ts (v1.1.0).
//
// The AI binding is pinned to the worker's own Cloudflare account, so a user's
// gateway is only reachable over HTTP. These pin the request each transport
// builds and prove an account-scoped context never touches the binding.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiLogId,
  aiRun,
  buildRestRunRequest,
  gatewayProviderUrl,
  unwrapRestResponse,
  type AiContext,
} from "../src/ai-binding";
import type { Env } from "../src/env";

const ACCT = "0123456789abcdef0123456789abcdef";

// A binding that fails the test if anything reaches it.
function trapBinding(): Env["AI"] {
  const trap = () => { throw new Error("host AI binding was called"); };
  return { run: trap, gateway: trap, aiGatewayLogId: "host-log" } as unknown as Env["AI"];
}

function userCtx(): AiContext {
  return {
    env: { AI: trapBinding() } as Env,
    gateway: { gatewayId: "user-gw", cfAigToken: "user-token", accountId: ACCT },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("buildRestRunRequest", () => {
  it("partner models use the /ai/run envelope on the user's account", () => {
    const { url, init } = buildRestRunRequest(ACCT, userCtx().gateway, "openai/gpt-5.5", { messages: [] });
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run`);
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer user-token");
    expect(h["cf-aig-gateway-id"]).toBe("user-gw");
    expect(JSON.parse(init.body as string)).toEqual({ model: "openai/gpt-5.5", input: { messages: [] } });
  });

  it("Workers AI models use the model-in-path endpoint with bare params", () => {
    const { url, init } = buildRestRunRequest(ACCT, userCtx().gateway, "@cf/baai/bge-base-en-v1.5", { text: ["a"] });
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run/@cf/baai/bge-base-en-v1.5`);
    expect(JSON.parse(init.body as string)).toEqual({ text: ["a"] });
  });
});

describe("aiRun transport selection", () => {
  it("account-scoped: fetches the user's account and never touches the binding", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, result: { response: "hi" }, errors: [] }),
      { headers: { "content-type": "application/json", "cf-aig-log-id": "user-log" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = userCtx();
    const out = await aiRun(ctx, "openai/gpt-5.5", { messages: [] });
    expect(out).toEqual({ response: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(aiLogId(ctx)).toBe("user-log");
  });

  it("account-scoped aiLogId never reads the host binding's log id", () => {
    expect(aiLogId(userCtx())).toBeNull();
  });

  it("host context (accountId null) still uses the binding with the gateway id", async () => {
    const run = vi.fn(async () => ({ ok: 1 }));
    const ctx: AiContext = {
      env: { AI: { run } } as unknown as Env,
      gateway: { gatewayId: "host-gw", cfAigToken: "", accountId: null },
    };
    await aiRun(ctx, "@cf/x/y", { a: 1 });
    expect(run).toHaveBeenCalledWith("@cf/x/y", { a: 1 }, { gateway: { id: "host-gw" } });
  });
});

describe("gatewayProviderUrl", () => {
  it("builds the provider-native URL from the user's account", async () => {
    expect(await gatewayProviderUrl(userCtx(), "anthropic"))
      .toBe(`https://gateway.ai.cloudflare.com/v1/${ACCT}/user-gw/anthropic`);
  });

  it("encodes a hostile stored slug rather than letting it rewrite the path", async () => {
    const ctx = userCtx();
    ctx.gateway.gatewayId = "../evil";
    expect(await gatewayProviderUrl(ctx, "grok"))
      .toBe(`https://gateway.ai.cloudflare.com/v1/${ACCT}/..%2Fevil/grok`);
  });

  it("host context delegates to the binding's getUrl", async () => {
    const getUrl = vi.fn(async (p: string) => `https://gateway.ai.cloudflare.com/v1/host/host-gw/${p}`);
    const ctx: AiContext = {
      env: { AI: { gateway: () => ({ getUrl }) } } as unknown as Env,
      gateway: { gatewayId: "host-gw", cfAigToken: "t", accountId: null },
    };
    expect(await gatewayProviderUrl(ctx, "anthropic")).toContain("/host/host-gw/anthropic");
  });
});

describe("unwrapRestResponse", () => {
  it("unwraps the Cloudflare API envelope", async () => {
    const r = new Response(JSON.stringify({ success: true, result: { data: [[1]] } }), {
      headers: { "content-type": "application/json" },
    });
    expect(await unwrapRestResponse(r, ACCT, false)).toEqual({ data: [[1]] });
  });

  it("passes non-envelope JSON through untouched", async () => {
    const r = new Response(JSON.stringify({ type: "message", content: [] }), {
      headers: { "content-type": "application/json" },
    });
    expect(await unwrapRestResponse(r, ACCT, false)).toEqual({ type: "message", content: [] });
  });

  it("throws on success:false with the API's message", async () => {
    const r = new Response(JSON.stringify({ success: false, errors: [{ message: "no credits" }] }), {
      headers: { "content-type": "application/json" },
    });
    await expect(unwrapRestResponse(r, ACCT, false)).rejects.toThrow(/no credits/);
  });

  it("a 401 names the permissions and the account, so the failure is actionable", async () => {
    const r = new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    await expect(unwrapRestResponse(r, ACCT, false))
      .rejects.toThrow(new RegExp(`401: 10000 Authentication error.*Workers AI Read.*${ACCT}`));
  });

  it("returns the body stream for SSE", async () => {
    const r = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    expect(await unwrapRestResponse(r, ACCT, false)).toBeInstanceOf(ReadableStream);
  });

  it("raw mode returns binary responses as-is", async () => {
    const r = new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } });
    const out = await unwrapRestResponse(r, ACCT, true) as Response;
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("raw mode turns a JSON { audio: base64 } result into audio bytes", async () => {
    const r = new Response(JSON.stringify({ success: true, result: { audio: "AQI=" } }), {
      headers: { "content-type": "application/json" },
    });
    const out = await unwrapRestResponse(r, ACCT, true) as Response;
    expect(out.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });
});
