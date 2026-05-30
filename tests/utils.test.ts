// Tests for the base64 encode/decode pair in utils (bytesToBase64 added
// v0.21.6 to inline R2 source images as data: URIs for image-to-video).
// The key property is a clean round-trip with base64ToBytes, including across
// the 0x8000-char chunk boundary (the reason btoa(String.fromCharCode(...))
// can't be used naively on large inputs).

import { describe, it, expect } from "vitest";
import { bytesToBase64, base64ToBytes, parseDataUrl } from "../src/utils";

describe("bytesToBase64 / base64ToBytes round-trip", () => {
  it("round-trips a short byte sequence", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 13, 10, 65]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("round-trips an empty array", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
    expect(base64ToBytes("").length).toBe(0);
  });

  it("round-trips a buffer larger than the 0x8000 chunk boundary", () => {
    const n = 0x8000 * 2 + 123; // spans three chunks
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(round.length).toBe(n);
    expect(round[0]).toBe(bytes[0]);
    expect(round[0x8000]).toBe(bytes[0x8000]);   // first byte of chunk 2
    expect(round[n - 1]).toBe(bytes[n - 1]);
  });

  it("produces a data URI that parseDataUrl can read back", () => {
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
    const uri = `data:image/png;base64,${bytesToBase64(bytes)}`;
    const parsed = parseDataUrl(uri);
    expect(parsed?.mime).toBe("image/png");
    expect(Array.from(base64ToBytes(parsed!.base64))).toEqual([137, 80, 78, 71]);
  });
});
