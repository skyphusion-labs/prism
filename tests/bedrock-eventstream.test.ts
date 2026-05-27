// Tests for parseBedrockEventStreamFrames (extracted in v0.18.0 from
// callBedrockNovaStream for testability).
//
// All fixtures are hand-crafted per the AWS EventStream binary format spec
// rather than captured from live upstream. Real captures would be marginally
// better evidence of correctness; hand-crafted fixtures exercise every
// branch deterministically.

import { describe, it, expect } from "vitest";
import { parseBedrockEventStreamFrames } from "../src/parsers/bedrock-eventstream";

// ---------- Frame construction helpers ----------

const enc = new TextEncoder();

/**
 * Build a single AWS EventStream binary frame.
 *
 * Frame layout (per https://docs.aws.amazon.com/transcribe/latest/dg/event-stream.html):
 *   [4 BE]  total_length
 *   [4 BE]  headers_length
 *   [4 BE]  prelude_crc       (zeros - parser doesn't validate)
 *   [N]     headers
 *   [M]     payload
 *   [4 BE]  message_crc       (zeros - parser doesn't validate)
 *
 * Header layout (per header, type=7 string only - that's all the parser needs):
 *   [1]     name_length
 *   [N]     name (UTF-8)
 *   [1]     value_type = 7
 *   [2 BE]  value_length
 *   [N]     value (UTF-8)
 */
function buildFrame(headers: Record<string, string>, payload: string): Uint8Array {
  const headerParts: Uint8Array[] = [];
  let headersLen = 0;
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let p = 0;
    part[p++] = nameBytes.length;
    part.set(nameBytes, p); p += nameBytes.length;
    part[p++] = 7; // string type
    part[p++] = (valueBytes.length >> 8) & 0xff;
    part[p++] = valueBytes.length & 0xff;
    part.set(valueBytes, p);
    headerParts.push(part);
    headersLen += part.length;
  }

  const payloadBytes = enc.encode(payload);
  const totalLen = 12 + headersLen + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLen);
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  dv.setUint32(0, totalLen, false);
  dv.setUint32(4, headersLen, false);
  dv.setUint32(8, 0, false);

  let offset = 12;
  for (const part of headerParts) {
    frame.set(part, offset);
    offset += part.length;
  }
  frame.set(payloadBytes, offset);
  offset += payloadBytes.length;
  dv.setUint32(offset, 0, false);

  return frame;
}

function concat(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of bufs) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

// ---------- Tests ----------

describe("parseBedrockEventStreamFrames", () => {
  describe("buffer states", () => {
    it("returns empty events and empty remainder for an empty buffer", () => {
      const result = parseBedrockEventStreamFrames(new Uint8Array(0));
      expect(result.events).toEqual([]);
      expect(result.remainder.length).toBe(0);
    });

    it("returns empty events and unchanged remainder for a sub-prelude buffer (< 12 bytes)", () => {
      const partial = new Uint8Array([0, 0, 0, 100, 0, 0, 0]);
      const result = parseBedrockEventStreamFrames(partial);
      expect(result.events).toEqual([]);
      expect(result.remainder).toEqual(partial);
    });

    it("returns unchanged remainder when total_length exceeds buffer", () => {
      const complete = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"text":"hi"}}',
      );
      const partial = complete.slice(0, complete.length - 10);
      const result = parseBedrockEventStreamFrames(partial);
      expect(result.events).toEqual([]);
      expect(result.remainder).toEqual(partial);
    });
  });

  describe("event extraction", () => {
    it("extracts a single text delta from a contentBlockDelta frame", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"text":"hello"},"contentBlockIndex":0}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([{ type: "text", text: "hello" }]);
      expect(result.remainder.length).toBe(0);
    });

    it("extracts usage from a metadata frame", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "metadata" },
        '{"usage":{"inputTokens":42,"outputTokens":17},"metrics":{"latencyMs":234}}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([{ type: "usage", in_: 42, out_: 17 }]);
    });

    it("handles null/missing token counts in metadata usage", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "metadata" },
        '{"usage":{"inputTokens":42}}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([{ type: "usage", in_: 42, out_: null }]);
    });

    it("extracts multiple events from multiple frames concatenated", () => {
      const buf = concat(
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockDelta" },
          '{"delta":{"text":"foo"}}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockDelta" },
          '{"delta":{"text":"bar"}}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "metadata" },
          '{"usage":{"inputTokens":10,"outputTokens":20}}',
        ),
      );
      const result = parseBedrockEventStreamFrames(buf);
      expect(result.events).toEqual([
        { type: "text", text: "foo" },
        { type: "text", text: "bar" },
        { type: "usage", in_: 10, out_: 20 },
      ]);
      expect(result.remainder.length).toBe(0);
    });

    it("handles a frame split across two reads", () => {
      const complete = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"text":"split"}}',
      );
      const half = Math.floor(complete.length / 2);
      const firstHalf = complete.slice(0, half);
      const r1 = parseBedrockEventStreamFrames(firstHalf);
      expect(r1.events).toEqual([]);
      expect(r1.remainder).toEqual(firstHalf);

      // Caller appends the rest to the remainder and calls again.
      const combined = concat(r1.remainder, complete.slice(half));
      const r2 = parseBedrockEventStreamFrames(combined);
      expect(r2.events).toEqual([{ type: "text", text: "split" }]);
      expect(r2.remainder.length).toBe(0);
    });

    it("yields complete frames and preserves an incomplete trailing frame as remainder", () => {
      const complete = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"text":"first"}}',
      );
      const trailing = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"text":"second"}}',
      );
      const trailingPartial = trailing.slice(0, Math.floor(trailing.length / 2));
      const buf = concat(complete, trailingPartial);

      const result = parseBedrockEventStreamFrames(buf);
      expect(result.events).toEqual([{ type: "text", text: "first" }]);
      expect(result.remainder).toEqual(trailingPartial);
    });
  });

  describe("ignored frames", () => {
    it("ignores messageStart frame", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "messageStart" },
        '{"role":"assistant"}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([]);
      expect(result.remainder.length).toBe(0);
    });

    it("ignores messageStop frame", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "messageStop" },
        '{"stopReason":"end_turn"}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([]);
    });

    it("ignores contentBlockStart and contentBlockStop frames", () => {
      const buf = concat(
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockStart" },
          '{"start":{"text":""},"contentBlockIndex":0}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockStop" },
          '{"contentBlockIndex":0}',
        ),
      );
      const result = parseBedrockEventStreamFrames(buf);
      expect(result.events).toEqual([]);
    });

    it("ignores contentBlockDelta with empty-string text", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"text":""}}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([]);
    });

    it("ignores contentBlockDelta with no text field (e.g. tool-use delta)", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        '{"delta":{"toolUse":{"input":"{}"}}}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([]);
    });

    it("ignores frames with malformed JSON payload without throwing", () => {
      const frame = buildFrame(
        { ":message-type": "event", ":event-type": "contentBlockDelta" },
        "not even json {{{",
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([]);
      expect(result.remainder.length).toBe(0);
    });

    it("ignores frames with non-event message-type (other than exception)", () => {
      const frame = buildFrame(
        { ":message-type": "unknown-type", ":event-type": "whatever" },
        '{"x":1}',
      );
      const result = parseBedrockEventStreamFrames(frame);
      expect(result.events).toEqual([]);
    });
  });

  describe("error frames (synchronous throws)", () => {
    it("throws with the upstream message for :message-type=exception", () => {
      const frame = buildFrame(
        { ":message-type": "exception", ":event-type": "throttlingException" },
        '{"message":"Rate limit exceeded for Nova Pro"}',
      );
      expect(() => parseBedrockEventStreamFrames(frame)).toThrow(
        /Bedrock Nova stream exception \(throttlingException\): Rate limit exceeded for Nova Pro/,
      );
    });

    it("falls back to capitalized Message field on exception", () => {
      const frame = buildFrame(
        { ":message-type": "exception", ":event-type": "internalServerException" },
        '{"Message":"backend boom"}',
      );
      expect(() => parseBedrockEventStreamFrames(frame)).toThrow(/backend boom/);
    });

    it("falls back to raw payload when exception JSON is malformed", () => {
      const frame = buildFrame(
        { ":message-type": "exception", ":event-type": "modelStreamErrorException" },
        "raw error text (not JSON)",
      );
      expect(() => parseBedrockEventStreamFrames(frame)).toThrow(/raw error text \(not JSON\)/);
    });

    it("throws on bogus frame length (< 16 minimum)", () => {
      const bogus = new Uint8Array(12);
      const dv = new DataView(bogus.buffer);
      dv.setUint32(0, 4, false);
      expect(() => parseBedrockEventStreamFrames(bogus)).toThrow(
        /Bedrock Nova streaming: bogus frame length 4/,
      );
    });

    it("throws on bogus frame length (> 16 MiB cap)", () => {
      const bogus = new Uint8Array(12);
      const dv = new DataView(bogus.buffer);
      dv.setUint32(0, 32 * 1024 * 1024, false);
      expect(() => parseBedrockEventStreamFrames(bogus)).toThrow(/bogus frame length/);
    });
  });

  describe("realistic conversation stream", () => {
    // Simulates the typical event sequence Nova emits for one turn:
    //   messageStart -> contentBlockDelta x N -> contentBlockStop -> messageStop -> metadata
    it("extracts text deltas in order and final usage from a realistic turn", () => {
      const buf = concat(
        buildFrame(
          { ":message-type": "event", ":event-type": "messageStart" },
          '{"role":"assistant"}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockDelta" },
          '{"delta":{"text":"The "}}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockDelta" },
          '{"delta":{"text":"quick "}}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockDelta" },
          '{"delta":{"text":"brown fox."}}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "contentBlockStop" },
          '{"contentBlockIndex":0}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "messageStop" },
          '{"stopReason":"end_turn"}',
        ),
        buildFrame(
          { ":message-type": "event", ":event-type": "metadata" },
          '{"usage":{"inputTokens":15,"outputTokens":8}}',
        ),
      );
      const result = parseBedrockEventStreamFrames(buf);
      expect(result.events).toEqual([
        { type: "text", text: "The " },
        { type: "text", text: "quick " },
        { type: "text", text: "brown fox." },
        { type: "usage", in_: 15, out_: 8 },
      ]);
      expect(result.remainder.length).toBe(0);
    });
  });
});
