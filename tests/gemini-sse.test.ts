// Tests for the Gemini SSE interpreter + delta reconciler (v0.21.4).
//
// The interpreter is stateless (frame text + usage). The reconciler is the
// load-bearing piece: it must yield correct non-repeating deltas whether the
// binding streams incremental pieces or cumulative full-text-so-far chunks,
// since we don't probe which mode is in use.

import { describe, it, expect } from "vitest";
import { interpretGeminiSSEFrame, makeGeminiDeltaReconciler } from "../src/parsers/gemini-sse";

describe("interpretGeminiSSEFrame", () => {
  it("extracts candidate part text", () => {
    const frame = { candidates: [{ content: { parts: [{ text: "Hello" }] } }] };
    expect(interpretGeminiSSEFrame(frame)).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("joins multiple parts in a frame", () => {
    const frame = { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] };
    expect(interpretGeminiSSEFrame(frame)).toEqual([{ type: "text", text: "ab" }]);
  });

  it("drops an empty-text frame", () => {
    expect(interpretGeminiSSEFrame({ candidates: [{ content: { parts: [{ text: "" }] } }] })).toEqual([]);
    expect(interpretGeminiSSEFrame({ candidates: [{ content: { parts: [] } }] })).toEqual([]);
  });

  it("reads usageMetadata into a usage event", () => {
    const frame = { usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 22, thoughtsTokenCount: 5 } };
    expect(interpretGeminiSSEFrame(frame)).toEqual([{ type: "usage", in_: 8, out_: 22 }]);
  });

  it("yields text then usage when a frame carries both", () => {
    const frame = {
      candidates: [{ content: { parts: [{ text: "done" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    };
    expect(interpretGeminiSSEFrame(frame)).toEqual([
      { type: "text", text: "done" },
      { type: "usage", in_: 1, out_: 2 },
    ]);
  });

  it("does not throw on null / undefined / string", () => {
    expect(interpretGeminiSSEFrame(null)).toEqual([]);
    expect(interpretGeminiSSEFrame(undefined)).toEqual([]);
    expect(interpretGeminiSSEFrame("[DONE]")).toEqual([]);
  });
});

describe("makeGeminiDeltaReconciler", () => {
  it("passes incremental chunks through unchanged", () => {
    const r = makeGeminiDeltaReconciler();
    const frames = ["one", "\n", "two", "\n", "three"];
    expect(frames.map(r).join("")).toBe("one\ntwo\nthree");
    // each delta is exactly the incremental piece
    const r2 = makeGeminiDeltaReconciler();
    expect(frames.map(r2)).toEqual(["one", "\n", "two", "\n", "three"]);
  });

  it("diffs cumulative chunks down to the new suffix", () => {
    const r = makeGeminiDeltaReconciler();
    const frames = ["one", "one\n", "one\ntwo", "one\ntwo\n", "one\ntwo\nthree"];
    expect(frames.map(r)).toEqual(["one", "\n", "two", "\n", "three"]);
    expect(frames.map(makeGeminiDeltaReconciler())).not.toContain("one\ntwo"); // no repetition
  });

  it("reconstructs the same final text in both modes", () => {
    const incremental = ["The ", "quick ", "brown ", "fox"];
    const cumulative = ["The ", "The quick ", "The quick brown ", "The quick brown fox"];
    const ri = makeGeminiDeltaReconciler();
    const rc = makeGeminiDeltaReconciler();
    expect(incremental.map(ri).join("")).toBe("The quick brown fox");
    expect(cumulative.map(rc).join("")).toBe("The quick brown fox");
  });
});
