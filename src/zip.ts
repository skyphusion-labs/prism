// v0.25.0: minimal, zero-dependency ZIP reader for the Workers runtime.
//
// Parsing is driven off the central directory (not the local headers), which
// is what makes this robust: the central directory always carries the real
// compressed/uncompressed sizes even when an entry was written with a
// streaming data descriptor (general-purpose bit 3), so we never have to chase
// the descriptor that trails the file data. For each entry we read its sizes,
// name, and local-header offset from the central directory, then seek to the
// local header only to skip past its (possibly different) name/extra fields
// and slice out the compressed bytes.
//
// Decompression uses the Workers-native DecompressionStream("deflate-raw"),
// which is also available in Node 18+ (so this module is unit-testable without
// the Workers pool). Stored (method 0) entries are copied as-is; deflate
// (method 8) entries are inflated. Any other method, encrypted entries, and
// zip64 archives are skipped/rejected. The 10MB document upload cap keeps real
// archives well under the zip64 threshold, so rejecting zip64 is safe here.

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

export interface UnzipLimits {
  maxEntries: number;      // refuse archives declaring more entries than this
  maxTotalBytes: number;   // cap on cumulative uncompressed output (zip-bomb guard)
  maxFileBytes: number;    // cap on a single entry's uncompressed size
}

export interface UnzipResult {
  entries: ZipEntry[];
  skipped: Array<{ name: string; reason: string }>;
}

const SIG_EOCD = 0x06054b50;   // end of central directory
const SIG_CD = 0x02014b50;     // central directory file header
const SIG_LOCAL = 0x04034b50;  // local file header

// Magic-byte check: a ZIP starts with a local file header, or with the EOCD
// signature in the empty-archive case. Detection is independent of extension.
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||   // local file header "PK\x03\x04"
     (bytes[2] === 0x05 && bytes[3] === 0x06));     // empty archive EOCD "PK\x05\x06"
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(data).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes: Uint8Array, limits: UnzipLimits): Promise<UnzipResult> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);

  // The EOCD lives at the tail. Its trailing comment can be up to 65535 bytes,
  // so scan backwards through that window for the signature.
  const MIN_EOCD = 22;
  let eocd = -1;
  const floor = Math.max(0, bytes.length - (MIN_EOCD + 0xffff));
  for (let i = bytes.length - MIN_EOCD; i >= floor; i--) {
    if (u32(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip (no end-of-central-directory record)");

  const cdCount = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (cdCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  if (cdCount > limits.maxEntries) {
    throw new Error(`zip declares ${cdCount} entries, over the limit of ${limits.maxEntries}`);
  }

  const entries: ZipEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let p = cdOffset;

  for (let n = 0; n < cdCount; n++) {
    if (u32(p) !== SIG_CD) throw new Error("corrupt zip (bad central directory header)");
    const flag = u16(p + 8);
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const uncompSize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p = p + 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;  // directory entry, no data
    if (flag & 0x0001) { skipped.push({ name, reason: "encrypted" }); continue; }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      skipped.push({ name, reason: "zip64 entry not supported" }); continue;
    }
    if (uncompSize > limits.maxFileBytes) {
      skipped.push({ name, reason: `uncompressed size ${uncompSize} over per-file limit` }); continue;
    }
    if (total + uncompSize > limits.maxTotalBytes) {
      skipped.push({ name, reason: "cumulative uncompressed size limit reached" }); continue;
    }

    // Seek the local header to find where the data actually starts. The local
    // header's name/extra lengths can differ from the central directory's, so
    // re-read them here rather than reusing nameLen/extraLen.
    if (u32(localOffset) !== SIG_LOCAL) { skipped.push({ name, reason: "bad local header" }); continue; }
    const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    let out: Uint8Array;
    if (method === 0) {
      out = comp.slice();
    } else if (method === 8) {
      try {
        out = await inflateRaw(comp);
      } catch {
        skipped.push({ name, reason: "inflate failed" });
        continue;
      }
    } else {
      skipped.push({ name, reason: `unsupported compression method ${method}` });
      continue;
    }

    if (out.length > limits.maxFileBytes) {
      skipped.push({ name, reason: `inflated size ${out.length} over per-file limit` }); continue;
    }
    if (total + out.length > limits.maxTotalBytes) {
      skipped.push({ name, reason: "cumulative inflated size limit reached" }); continue;
    }

    total += out.length;
    entries.push({ name, bytes: out });
  }

  return { entries, skipped };
}
