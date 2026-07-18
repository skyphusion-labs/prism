// Pure-logic tests for password hashing (v0.167.0, issue #80).

import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  parsePhc,
  constantTimeEqual,
  PBKDF2_ITERATIONS,
} from "../src/auth-kdf";

describe("hashPassword / verifyPassword", () => {
  it("round-trips the correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct Horse Battery Staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("produces a PHC string with the expected algo, hash, and iteration count", async () => {
    const stored = await hashPassword("hunter2hunter2");
    const parsed = parsePhc(stored);
    expect(stored.startsWith(`pbkdf2$sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect(parsed).not.toBeNull();
    expect(parsed!.iterations).toBe(PBKDF2_ITERATIONS);
    expect(parsed!.salt.length).toBe(16);
    expect(parsed!.hash.length).toBe(32);
  });

  it("salts per call: same password yields different stored hashes", async () => {
    const a = await hashPassword("samepassword123");
    const b = await hashPassword("samepassword123");
    expect(a).not.toBe(b);
    expect(await verifyPassword("samepassword123", a)).toBe(true);
    expect(await verifyPassword("samepassword123", b)).toBe(true);
  });

  it("fails closed on a malformed stored value", async () => {
    expect(await verifyPassword("x", "not-a-phc-string")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$notnum$AA==$AA==")).toBe(false);
    expect(await verifyPassword("x", "argon2$sha256$1$AA==$AA==")).toBe(false);
    expect(parsePhc("a$b$c")).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("true only for identical byte arrays", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("false for different lengths", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
