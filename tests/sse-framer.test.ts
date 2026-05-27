// Tests for extractSSEDataPayloads (v0.18.1), the shared SSE framer used by
// all three streaming provider parsers (xAI, Workers AI, Anthropic).
//
// Behavior under test is exactly what the inline implementations in
// callXaiStream / callWorkersAIStream / callAnthropicStream did before
// extraction; new framer is a pure relocation, not a redesign.

import { describe, it, expect } from "vitest";
import { extractSSEDataPayloads } from "../src/parsers/sse-framer";

describe("extractSSEDataPayloads", () => {
  describe("buffer states", () => {
    it("returns no payloads and empty remainder for empty buffer", () => {
      const { payloads, remainder } = extractSSEDataPayloads("");
      expect(payloads).toEqual([]);
      expect(remainder).toBe("");
    });

    it("returns no payloads and full buffer as remainder when no event boundary present", () => {
      const buf = "data: {\"partial\":";
      const { payloads, remainder } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual([]);
      expect(remainder).toBe(buf);
    });

    it("preserves incomplete trailing event as remainder", () => {
      const buf = 'data: {"complete":1}\n\ndata: {"part';
      const { payloads, remainder } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"complete":1}']);
      expect(remainder).toBe('data: {"part');
    });
  });

  describe("payload extraction", () => {
    it("extracts a single complete event", () => {
      const { payloads, remainder } = extractSSEDataPayloads('data: {"x":1}\n\n');
      expect(payloads).toEqual(['{"x":1}']);
      expect(remainder).toBe("");
    });

    it("extracts multiple events in order", () => {
      const buf = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n';
      const { payloads, remainder } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
      expect(remainder).toBe("");
    });

    it("handles compact `data:` prefix (no trailing space)", () => {
      const { payloads } = extractSSEDataPayloads('data:{"compact":true}\n\n');
      expect(payloads).toEqual(['{"compact":true}']);
    });

    it("handles mixed spaced and compact prefixes across events", () => {
      const buf = 'data: {"a":1}\n\ndata:{"b":2}\n\n';
      const { payloads } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("ignores event:, id:, retry: lines and extracts only the data: payload", () => {
      const buf =
        'event: message_start\nid: msg_01\nretry: 5000\ndata: {"type":"message_start"}\n\n';
      const { payloads } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"type":"message_start"}']);
    });
  });

  describe("dropped events", () => {
    it("drops the [DONE] sentinel", () => {
      const buf = 'data: {"x":1}\n\ndata: [DONE]\n\n';
      const { payloads } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"x":1}']);
    });

    it("drops whitespace-only events", () => {
      const buf = '   \n\ndata: {"x":1}\n\n';
      const { payloads } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"x":1}']);
    });

    it("drops events whose only data: line has empty content", () => {
      // `data:` with nothing after produces an empty payload, which is skipped.
      const buf = 'data:\n\ndata: {"x":1}\n\n';
      const { payloads } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"x":1}']);
    });
  });

  describe("multi-data-line behavior (last wins)", () => {
    // SSE spec says multiple data: lines in one event should concat with
    // newlines, but none of our three providers emit multi-line data fields.
    // The pre-extraction implementations used "last data: line wins"; the
    // framer preserves that exactly.
    it("uses the last data: line when an event has multiple", () => {
      const buf = 'data: {"first":1}\ndata: {"second":2}\n\n';
      const { payloads } = extractSSEDataPayloads(buf);
      expect(payloads).toEqual(['{"second":2}']);
    });
  });

  describe("split-across-reads behavior", () => {
    it("yields complete events and preserves partial remainder across reads", () => {
      // First read: one complete event + start of second
      const r1 = extractSSEDataPayloads('data: {"a":1}\n\ndata: {"b":');
      expect(r1.payloads).toEqual(['{"a":1}']);
      expect(r1.remainder).toBe('data: {"b":');

      // Caller appends next chunk and re-frames
      const r2 = extractSSEDataPayloads(r1.remainder + '2}\n\ndata: {"c":3}\n\n');
      expect(r2.payloads).toEqual(['{"b":2}', '{"c":3}']);
      expect(r2.remainder).toBe("");
    });
  });
});
