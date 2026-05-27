// Tests for interpretAnthropicSSEFrame (v0.18.1). Behavior preserved from
// the inline implementation in callAnthropicStream pre-extraction.

import { describe, it, expect } from "vitest";
import { interpretAnthropicSSEFrame } from "../src/parsers/anthropic-sse";

describe("interpretAnthropicSSEFrame", () => {
  describe("message_start", () => {
    it("yields a usage event from initial message_start", () => {
      const data = {
        type: "message_start",
        message: {
          id: "msg_01",
          role: "assistant",
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      };
      expect(interpretAnthropicSSEFrame(data)).toEqual([
        { type: "usage", in_: 100, out_: 1 },
      ]);
    });

    it("yields no event if message_start has no usage", () => {
      const data = { type: "message_start", message: { id: "msg_01", role: "assistant" } };
      expect(interpretAnthropicSSEFrame(data)).toEqual([]);
    });
  });

  describe("content_block_delta", () => {
    it("yields a text event for a text_delta", () => {
      const data = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      };
      expect(interpretAnthropicSSEFrame(data)).toEqual([
        { type: "text", text: "Hello" },
      ]);
    });

    it("ignores non-text-delta types (e.g. tool-use input_json_delta)", () => {
      const data = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      };
      expect(interpretAnthropicSSEFrame(data)).toEqual([]);
    });

    it("ignores delta with no text field", () => {
      const data = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta" },
      };
      expect(interpretAnthropicSSEFrame(data)).toEqual([]);
    });
  });

  describe("message_delta", () => {
    it("yields a usage event with final output_tokens count", () => {
      const data = {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 100, output_tokens: 42 },
      };
      expect(interpretAnthropicSSEFrame(data)).toEqual([
        { type: "usage", in_: 100, out_: 42 },
      ]);
    });

    it("yields no event if message_delta has no usage", () => {
      const data = { type: "message_delta", delta: { stop_reason: "end_turn" } };
      expect(interpretAnthropicSSEFrame(data)).toEqual([]);
    });

    it("returns null for missing token fields in usage", () => {
      const data = { type: "message_delta", usage: { output_tokens: 42 } };
      expect(interpretAnthropicSSEFrame(data)).toEqual([
        { type: "usage", in_: null, out_: 42 },
      ]);
    });
  });

  describe("ignored event types", () => {
    it("ignores content_block_start", () => {
      const data = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      };
      expect(interpretAnthropicSSEFrame(data)).toEqual([]);
    });

    it("ignores content_block_stop", () => {
      expect(interpretAnthropicSSEFrame({ type: "content_block_stop", index: 0 })).toEqual([]);
    });

    it("ignores message_stop", () => {
      expect(interpretAnthropicSSEFrame({ type: "message_stop" })).toEqual([]);
    });

    it("ignores ping events", () => {
      expect(interpretAnthropicSSEFrame({ type: "ping" })).toEqual([]);
    });

    it("ignores unknown event types", () => {
      expect(interpretAnthropicSSEFrame({ type: "some_future_event", extra: 1 })).toEqual([]);
    });

    it("ignores frames with no type field", () => {
      expect(interpretAnthropicSSEFrame({ random: "junk" })).toEqual([]);
    });
  });

  describe("realistic conversation sequence", () => {
    // Walks a typical turn: message_start -> content_block_start ->
    // content_block_delta x N -> content_block_stop -> message_delta -> message_stop
    it("yields exactly the events callers need from a full turn sequence", () => {
      const frames: Array<{ type: string; [key: string]: unknown }> = [
        {
          type: "message_start",
          message: { id: "msg_01", role: "assistant", usage: { input_tokens: 50, output_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "quick " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fox." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 50, output_tokens: 8 },
        },
        { type: "message_stop" },
      ];

      const allEvents = frames.flatMap((f) => interpretAnthropicSSEFrame(f));

      expect(allEvents).toEqual([
        { type: "usage", in_: 50, out_: 1 },
        { type: "text", text: "The " },
        { type: "text", text: "quick " },
        { type: "text", text: "fox." },
        { type: "usage", in_: 50, out_: 8 },
      ]);
    });
  });
});
