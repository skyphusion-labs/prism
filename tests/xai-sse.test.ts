// Tests for interpretXaiSSEFrame (v0.18.1). Behavior preserved from the
// inline implementation in callXaiStream pre-extraction.

import { describe, it, expect } from "vitest";
import { interpretXaiSSEFrame } from "../src/parsers/xai-sse";

describe("interpretXaiSSEFrame", () => {
  it("extracts a text event from a delta frame", () => {
    const data = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "hello" } }],
    };
    expect(interpretXaiSSEFrame(data)).toEqual([{ type: "text", text: "hello" }]);
  });

  it("extracts a usage event from a usage frame", () => {
    const data = {
      usage: { prompt_tokens: 42, completion_tokens: 17 },
    };
    expect(interpretXaiSSEFrame(data)).toEqual([
      { type: "usage", in_: 42, out_: 17 },
    ]);
  });

  it("yields both events when a single frame has text delta and usage", () => {
    // Rare in practice (usage typically arrives in a separate final frame)
    // but the parser handles both fields independently.
    const data = {
      choices: [{ delta: { content: "fin." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(interpretXaiSSEFrame(data)).toEqual([
      { type: "text", text: "fin." },
      { type: "usage", in_: 10, out_: 5 },
    ]);
  });

  it("ignores empty-string content (final pre-usage frame)", () => {
    const data = { choices: [{ delta: { content: "" } }] };
    expect(interpretXaiSSEFrame(data)).toEqual([]);
  });

  it("ignores frames with no choices field", () => {
    const data = { id: "chatcmpl-1", object: "chat.completion.chunk" };
    expect(interpretXaiSSEFrame(data)).toEqual([]);
  });

  it("ignores delta with no content field", () => {
    const data = { choices: [{ delta: { role: "assistant" } }] };
    expect(interpretXaiSSEFrame(data)).toEqual([]);
  });

  it("returns null for missing token fields in usage", () => {
    const data = { usage: { prompt_tokens: 42 } };
    expect(interpretXaiSSEFrame(data)).toEqual([
      { type: "usage", in_: 42, out_: null },
    ]);
  });
});
