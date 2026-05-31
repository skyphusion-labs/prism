import { describe, it, expect } from "vitest";
import { isZip, unzip } from "../src/zip";

// v0.25.0: tests for the zero-dependency ZIP reader. We hand-build archives so
// the central-directory parsing, the stored vs deflate paths, directory
// skipping, and the limit guards are all exercised. CompressionStream /
// DecompressionStream are available natively in the Node test runtime.

const LIMITS = { maxEntries: 200, maxTotalBytes: 50 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024 };

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Response(data).body!.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface InFile { name: string; data: Uint8Array; method?: 0 | 8 }

// Build a minimal but spec-valid zip. CRC fields are left zero (the reader
// ignores them). Method 8 entries are deflate-raw compressed.
async function buildZip(files: InFile[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const method = f.method ?? 0;
    const nameBytes = enc.encode(f.name);
    const stored = method === 8 ? await deflateRaw(f.data) : f.data;

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(8, method, true);
    ldv.setUint32(18, stored.length, true);
    ldv.setUint32(22, f.data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    const localOffset = offset;
    local.push(lh, stored);
    offset += lh.length + stored.length;

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, method, true);
    cdv.setUint32(20, stored.length, true);
    cdv.setUint32(24, f.data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, localOffset, true);
    ch.set(nameBytes, 46);
    central.push(ch);
  }

  const cdStart = offset;
  const cdLen = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdLen, true);
  edv.setUint32(16, cdStart, true);

  return concat([...local, ...central, eocd]);
}

const td = (b: Uint8Array) => new TextDecoder().decode(b);
const te = (s: string) => new TextEncoder().encode(s);

describe("isZip", () => {
  it("detects the local-file-header magic", async () => {
    const zip = await buildZip([{ name: "a.txt", data: te("hi") }]);
    expect(isZip(zip)).toBe(true);
  });
  it("rejects non-zip bytes", () => {
    expect(isZip(te("not a zip at all"))).toBe(false);
    expect(isZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});

describe("unzip", () => {
  it("reads stored entries", async () => {
    const zip = await buildZip([
      { name: "a.txt", data: te("alpha") },
      { name: "b/c.txt", data: te("charlie") },
    ]);
    const { entries, skipped } = await unzip(zip, LIMITS);
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b/c.txt"]);
    expect(td(entries[0].bytes)).toBe("alpha");
    expect(td(entries[1].bytes)).toBe("charlie");
  });

  it("inflates deflate entries", async () => {
    const big = "the quick brown fox ".repeat(500);
    const zip = await buildZip([{ name: "doc.txt", data: te(big), method: 8 }]);
    const { entries } = await unzip(zip, LIMITS);
    expect(entries).toHaveLength(1);
    expect(td(entries[0].bytes)).toBe(big);
  });

  it("skips directory entries", async () => {
    const zip = await buildZip([
      { name: "folder/", data: new Uint8Array(0) },
      { name: "folder/x.txt", data: te("x") },
    ]);
    const { entries } = await unzip(zip, LIMITS);
    expect(entries.map((e) => e.name)).toEqual(["folder/x.txt"]);
  });

  it("skips entries over the per-file size limit", async () => {
    const zip = await buildZip([
      { name: "small.txt", data: te("ok") },
      { name: "big.txt", data: te("0123456789") },
    ]);
    const { entries, skipped } = await unzip(zip, { ...LIMITS, maxFileBytes: 5 });
    expect(entries.map((e) => e.name)).toEqual(["small.txt"]);
    expect(skipped).toEqual([{ name: "big.txt", reason: "uncompressed size 10 over per-file limit" }]);
  });

  it("throws when the entry count exceeds the limit", async () => {
    const zip = await buildZip([
      { name: "a.txt", data: te("a") },
      { name: "b.txt", data: te("b") },
    ]);
    await expect(unzip(zip, { ...LIMITS, maxEntries: 1 })).rejects.toThrow(/over the limit/);
  });

  it("throws on bytes with no end-of-central-directory record", async () => {
    await expect(unzip(te("garbage"), LIMITS)).rejects.toThrow(/not a valid zip/);
  });
});
