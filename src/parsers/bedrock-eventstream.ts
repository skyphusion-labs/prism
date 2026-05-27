// Bedrock eventstream binary parser (v0.18.0).
//
// Extracted from callBedrockNovaStream in src/index.ts to make the gnarliest
// parser in the codebase unit-testable in isolation. The worker's generator
// is now a thin shell that handles fetch I/O and AbortSignal; everything
// about turning bytes into ProviderStreamEvent values lives here.
//
// Frame format (per https://docs.aws.amazon.com/transcribe/latest/dg/event-stream.html):
//   [4 BE]  total_length
//   [4 BE]  headers_length
//   [4 BE]  prelude_crc       (CRC32 of first 8 bytes - we skip)
//   [N]     headers           (name/type/value triplets)
//   [M]     payload           (JSON for the events we care about)
//   [4 BE]  message_crc       (we skip)
//   payload_bytes M = total_length - 16 - headers_length
//
// Header types we handle:
//   - Type 7 (UTF-8 string, 2-byte BE length prefix): :message-type,
//     :event-type, :content-type - everything we actually read.
//   - Other types (0/1=bool, 2=byte, 3=int16, 4=int32, 5=int64, 6=bytearray,
//     8=timestamp, 9=UUID): length-tabulated and skipped defensively so an
//     unknown header doesn't desync the stream.
//
// Event types we react to:
//   contentBlockDelta -> {"delta":{"text":"..."}}                  yields text
//   metadata          -> {"usage":{"inputTokens":N,"outputTokens":M}} yields usage
//
// Other event types (messageStart, contentBlockStart, contentBlockStop,
// messageStop) carry no info we need for the flat envelope.

import type { ProviderStreamEvent } from "./types";

// Takes accumulated bytes received so far on the stream pipe, returns any
// complete frames found as normalized ProviderStreamEvent values plus
// unconsumed remainder bytes (which the caller will pass back in alongside
// the next chunk).
//
// Throws synchronously on:
//   - Bogus frame length (< 16 or > 16 MiB): unrecoverable, indicates
//     upstream wire-format drift.
//   - `:message-type=exception` frame: surfaces the upstream error to the
//     caller as a thrown Error, matching pre-extraction behavior.

export function parseBedrockEventStreamFrames(
  inputBuf: Uint8Array,
): { events: ProviderStreamEvent[]; remainder: Uint8Array } {
  const events: ProviderStreamEvent[] = [];
  let buf = inputBuf;
  const td = new TextDecoder();

  while (buf.length >= 12) {
    const totalLen = readU32BE(buf, 0);
    if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
      throw new Error(`Bedrock Nova streaming: bogus frame length ${totalLen}`);
    }
    if (buf.length < totalLen) break; // wait for more bytes

    const headersLen = readU32BE(buf, 4);
    const headersStart = 12; // skip prelude_crc at bytes 8..11
    const headersEnd = headersStart + headersLen;
    const payloadStart = headersEnd;
    const payloadEnd = totalLen - 4; // message_crc trails
    const headers = parseEventStreamHeaders(buf, headersStart, headersEnd);

    const messageType = headers[":message-type"];
    const eventType = headers[":event-type"];

    const payloadText = td.decode(buf.subarray(payloadStart, payloadEnd));
    buf = buf.slice(totalLen);

    if (messageType === "exception") {
      let msg = payloadText;
      try {
        const obj = JSON.parse(payloadText) as { message?: string; Message?: string };
        msg = obj.message ?? obj.Message ?? payloadText;
      } catch { /* keep raw */ }
      throw new Error(`Bedrock Nova stream exception (${eventType ?? "unknown"}): ${msg.slice(0, 500)}`);
    }

    if (messageType !== "event") continue;

    let data: {
      delta?: { text?: string };
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    try {
      data = JSON.parse(payloadText);
    } catch {
      continue;
    }

    if (eventType === "contentBlockDelta") {
      const text = data.delta?.text;
      if (typeof text === "string" && text.length > 0) {
        events.push({ type: "text", text });
      }
    } else if (eventType === "metadata") {
      if (data.usage) {
        events.push({
          type: "usage",
          in_: data.usage.inputTokens ?? null,
          out_: data.usage.outputTokens ?? null,
        });
      }
    }
    // messageStart, contentBlockStart, contentBlockStop, messageStop
    // carry no info we need for the flat envelope.
  }

  return { events, remainder: buf };
}

function readU32BE(buf: Uint8Array, at: number): number {
  return (
    ((buf[at] << 24) |
      (buf[at + 1] << 16) |
      (buf[at + 2] << 8) |
      buf[at + 3]) >>> 0
  );
}

function parseEventStreamHeaders(
  buf: Uint8Array,
  start: number,
  end: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  const td = new TextDecoder();
  let p = start;
  while (p < end) {
    const nameLen = buf[p]; p += 1;
    if (p + nameLen > end) break;
    const name = td.decode(buf.subarray(p, p + nameLen)); p += nameLen;
    if (p >= end) break;
    const valType = buf[p]; p += 1;
    if (valType === 7) {
      // String: 2-byte BE length, then UTF-8 data.
      if (p + 2 > end) break;
      const valLen = (buf[p] << 8) | buf[p + 1]; p += 2;
      if (p + valLen > end) break;
      out[name] = td.decode(buf.subarray(p, p + valLen)); p += valLen;
    } else {
      // Skip non-string header types defensively per the AWS EventStream spec.
      if (valType === 0 || valType === 1) {
        // boolean, no payload bytes
      } else if (valType === 2) {
        p += 1;
      } else if (valType === 3) {
        p += 2;
      } else if (valType === 4) {
        p += 4;
      } else if (valType === 5 || valType === 8) {
        p += 8;
      } else if (valType === 6) {
        if (p + 2 > end) break;
        const dlen = (buf[p] << 8) | buf[p + 1];
        p += 2 + dlen;
      } else if (valType === 9) {
        p += 16;
      } else {
        // Unknown type, give up cleanly with what we have.
        return out;
      }
    }
  }
  return out;
}
