// Tests for the v0.169.0 binding dispatch in src/providers/anthropic.ts.
//
// anthropic/claude-fable-5 is flagged binding: true, so callAnthropic /
// callAnthropicStream route through env.AI.run (the new Unified Billing catalog
// surface) instead of the legacy AI Gateway provider fetch path. The fake
// AiContext below stubs ONLY env.AI.run (the un-stubbable seam); everything
// downstream is the real shipped code: the Anthropic message transform, the
// shared SSE framer, and interpretAnthropicSSEFrame. That is what lets these
// exercise the actual wiring rather than a re-implementation of it.

import { describe, it, expect } from "vitest";
import type { AiContext } from "../src/ai-binding";
import type { ModelEntry } from "../src/models";
import { MODELS } from "../src/models";
import { callAnthropic, callAnthropicStream } from "../src/providers/anthropic";
import type { ProviderStreamEvent } from "../src/parsers/types";

const fableModel: ModelEntry = {
  id: "anthropic/claude-fable-5",
  label: "Claude Fable 5 (Anthropic)",
  group: "Chat · Anthropic",
  type: "chat",
  capabilities: ["vision"],
  provider: "anthropic",
  streaming: true,
  binding: true,
};

type RunCall = { model: string; params: Record<string, unknown>; opts: unknown };

function fakeCtx(runImpl: (model: string, params: unknown, opts: unknown) => Promise<unknown>): { ctx: AiContext; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const env = {
    AI: {
      run: (model: string, params: unknown, opts: unknown) => {
        calls.push({ model, params: params as Record<string, unknown>, opts });
        return runImpl(model, params, opts);
      },
      aiGatewayLogId: "log-123",
    },
  } as unknown as AiContext["env"];
  const ctx = { env, gateway: { gatewayId: "skyphusion-llm", cfAigToken: "tok" } } as unknown as AiContext;
  return { ctx, calls };
}

// Encode an array of Anthropic SSE frames as bytes, with the trailing spaces
// after each data JSON that fable-5 leaves on the wire, split into small chunks
// so the framer buffer-reassembly across reads is exercised too.
function sseStream(frames: unknown[], chunkSize = 7): ReadableStream<Uint8Array> {
  const text = frames.map((f) => "data: " + JSON.stringify(f) + "  \n\n").join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) { controller.close(); return; }
      const end = Math.min(i + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(i, end));
      i = end;
    },
  });
}

const userMessages = [
  { role: "user", content: [
    { type: "text", text: "hi" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] },
];

describe("catalog", () => {
  it("has claude-fable-5 flagged binding: true, provider anthropic, streaming", () => {
    const m = MODELS.find((x) => x.id === "anthropic/claude-fable-5");
    expect(m).toBeDefined();
    expect(m?.binding).toBe(true);
    expect(m?.provider).toBe("anthropic");
    expect(m?.streaming).toBe(true);
  });
});

describe("callAnthropic binding dispatch (non-stream)", () => {
  const fableMsg = {
    id: "msg_01Fable",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "CAISopaque==" },
      { type: "text", text: "OK." },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 5 },
  };

  it("calls env.AI.run with the catalog id and an Anthropic-shaped body, returns raw + logId", async () => {
    const { ctx, calls } = fakeCtx(async () => fableMsg);
    const { raw, logId } = await callAnthropic(ctx, fableModel, "sys", userMessages);

    expect(raw).toBe(fableMsg);
    expect(logId).toBe("log-123");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("anthropic/claude-fable-5");
    expect(calls[0].opts).toEqual({ gateway: { id: "skyphusion-llm" } });

    const p = calls[0].params;
    expect(p.max_tokens).toBe(4096);
    expect(p.system).toBe("sys");
    expect(p.stream).toBeUndefined();
    expect(p.messages).toEqual([
      { role: "user", content: [
        { type: "text", text: "hi" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] },
    ]);
  });

  it("a non-binding anthropic model does NOT take the binding path (the flag gates dispatch)", async () => {
    // With binding falsy, callAnthropic must fall to the legacy gateway fetch
    // path, which reads ctx.env.AI.gateway(...).getUrl(...). The fake AiContext
    // exposes no gateway method, so the legacy path throws and env.AI.run is
    // never invoked. This proves the dispatch is flag-driven, not always-binding.
    const { ctx, calls } = fakeCtx(async () => fableMsg);
    const legacyModel: ModelEntry = { ...fableModel, binding: false };
    await expect(callAnthropic(ctx, legacyModel, "sys", userMessages)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("callAnthropicStream binding dispatch (stream)", () => {
  const frames = [
    { type: "message_start", message: { id: "msg_01Fable", role: "assistant", usage: { input_tokens: 50, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "CAISopaque==" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 50, output_tokens: 5 } },
    { type: "message_stop" },
  ];

  async function collect(gen: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
    const out: ProviderStreamEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("drives the native Anthropic SSE stream through the real framer, surfacing only text + usage", async () => {
    const { ctx, calls } = fakeCtx(async () => sseStream(frames));
    const ac = new AbortController();
    const events = await collect(callAnthropicStream(ctx, fableModel, "sys", userMessages, ac.signal));

    expect(calls[0].params.stream).toBe(true);
    expect(events).toEqual([
      { type: "usage", in_: 50, out_: 1 },
      { type: "text", text: "OK." },
      { type: "usage", in_: 50, out_: 5 },
    ]);
    // The thinking signature must never leak into surfaced text.
    const textOut = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(textOut).toBe("OK.");
    expect(textOut).not.toContain("CAIS");
  });

  it("yields nothing when the abort signal is already tripped (client gone)", async () => {
    const { ctx, calls } = fakeCtx(async () => sseStream(frames));
    const ac = new AbortController();
    ac.abort();
    const events = await collect(callAnthropicStream(ctx, fableModel, "sys", userMessages, ac.signal));
    expect(events).toEqual([]);
    expect(calls).toHaveLength(1); // the run was issued, then cancelled without draining
  });
});
