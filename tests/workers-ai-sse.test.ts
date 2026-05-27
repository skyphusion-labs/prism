// Tests for interpretWorkersAISSEFrame (v0.18.1). Behavior preserved from
// the inline implementation in callWorkersAIStream pre-extraction.

import { describe, it, expect } from "vitest";
import { interpretWorkersAISSEFrame } from "../src/parsers/workers-ai-sse";

describe("interpretWorkersAISSEFrame", () => {
  it("extracts a text event from a `response` field", () => {
    expect(interpretWorkersAISSEFrame({ response: "hello" })).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("ignores empty-string response (typical for the final usage-only frame)", () => {
    expect(interpretWorkersAISSEFrame({ response: "" })).toEqual([]);
  });

  it("ignores frames with no response field", () => {
    expect(interpretWorkersAISSEFrame({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual([
      { type: "usage", in_: 1, out_: 2 },
    ]);
  });

  it("extracts usage with OpenAI naming", () => {
    const data = { usage: { prompt_tokens: 42, completion_tokens: 17 } };
    expect(interpretWorkersAISSEFrame(data)).toEqual([
      { type: "usage", in_: 42, out_: 17 },
    ]);
  });

  it("falls back to Anthropic-style naming when OpenAI fields are missing", () => {
    // Some Anthropic-derived adapters on Workers AI emit input_tokens/output_tokens.
    const data = { usage: { input_tokens: 100, output_tokens: 50 } };
    expect(interpretWorkersAISSEFrame(data)).toEqual([
      { type: "usage", in_: 100, out_: 50 },
    ]);
  });

  it("prefers OpenAI naming when both are present", () => {
    const data = {
      usage: { prompt_tokens: 1, completion_tokens: 2, input_tokens: 99, output_tokens: 99 },
    };
    expect(interpretWorkersAISSEFrame(data)).toEqual([
      { type: "usage", in_: 1, out_: 2 },
    ]);
  });

  it("passes through reasoning-model <think> blocks without modification", () => {
    // gpt-oss-120b/20b, qwq-32b, deepseek-r1-distill-qwen-32b emit reasoning
    // tags inline in `response`. The interpreter doesn't strip them; UI decides.
    const data = { response: "<think>let me work this out</think>The answer is 42." };
    expect(interpretWorkersAISSEFrame(data)).toEqual([
      { type: "text", text: "<think>let me work this out</think>The answer is 42." },
    ]);
  });

  it("yields both text and usage when a single frame has both", () => {
    const data = {
      response: "done",
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    expect(interpretWorkersAISSEFrame(data)).toEqual([
      { type: "text", text: "done" },
      { type: "usage", in_: 5, out_: 3 },
    ]);
  });
});
