// Password hashing for first-party auth (v0.167.0, issue #80).
//
// PBKDF2-HMAC-SHA-256 via WebCrypto SubtleCrypto: zero runtime dependency and
// available in the Workers runtime. scrypt/argon2 would each need a new runtime
// dep (CONTRIBUTING requires justification) and PBKDF2-native is adequate for
// the first cut. The stored value is a PHC-style string so the cost parameters
// travel with each hash and can be upgraded per-user on the next login (e.g. to
// an Argon2-WASM verifier later) without a schema migration:
//
//   pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
//
// 600000 iterations is the OWASP 2023 floor for PBKDF2-HMAC-SHA256; it lands
// around 50-100ms on the paid Workers CPU budget, well inside the request CPU
// limit. Salt is 16 random bytes; the derived key is 32 bytes.

const KDF_ALGO = "pbkdf2";
const KDF_HASH = "sha256";
export const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Fixed-length XOR-accumulate comparison. Workers has no crypto timingSafeEqual,
// so we compare two equal-length byte arrays in constant time relative to their
// length: unequal lengths return false immediately (a length leak is not a hash
// leak), equal lengths always walk the whole buffer.
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
  keyBytes: number,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    keyBytes * 8,
  );
  return new Uint8Array(bits);
}

// Hash a password into a self-describing PHC string. A fresh random salt is
// generated per call, so two identical passwords never share a stored hash.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(password, salt, PBKDF2_ITERATIONS, KEY_BYTES);
  return `${KDF_ALGO}$${KDF_HASH}$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(derived)}`;
}

interface ParsedPhc {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

// Parse a stored PHC string. Returns null on any structural mismatch (unknown
// algo/hash, non-numeric iterations, bad base64) so verify fails closed rather
// than throwing on a corrupt row.
export function parsePhc(stored: string): ParsedPhc | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algo, hashName, iterStr, saltB64, hashB64] = parts;
  if (algo !== KDF_ALGO || hashName !== KDF_HASH) return null;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;
  try {
    return { iterations, salt: fromB64(saltB64), hash: fromB64(hashB64) };
  } catch {
    return null;
  }
}

// Verify a candidate password against a stored PHC string. Constant-time on the
// digest compare; returns false for any malformed stored value.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePhc(stored);
  if (!parsed) return false;
  const derived = await deriveBits(password, parsed.salt, parsed.iterations, parsed.hash.length);
  return constantTimeEqual(derived, parsed.hash);
}
