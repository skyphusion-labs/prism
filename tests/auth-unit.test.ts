// Pure-logic tests for auth validation, user-id shape, and session cookies
// (v0.167.0, issue #80).

import { describe, expect, it } from "vitest";
import { validateUsername, validatePassword, generateUserId, DUMMY_PASSWORD_HASH } from "../src/auth";
import { parsePhc, PBKDF2_ITERATIONS } from "../src/auth-kdf";
import {
  SESSION_COOKIE,
  buildSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  generateSessionToken,
} from "../src/session";

describe("validateUsername", () => {
  it("accepts valid handles", () => {
    for (const u of ["abc", "user_1", "a-b-c", "Rollins42"]) {
      expect(validateUsername(u)).toBeNull();
    }
  });
  it("rejects invalid handles", () => {
    expect(validateUsername("ab")).not.toBeNull(); // too short
    expect(validateUsername("a".repeat(33))).not.toBeNull(); // too long
    expect(validateUsername("has space")).not.toBeNull();
    expect(validateUsername("bad!char")).not.toBeNull();
    expect(validateUsername("has.dot")).not.toBeNull(); // dot not in charset
    expect(validateUsername(123)).not.toBeNull();
    expect(validateUsername(undefined)).not.toBeNull();
  });
});

describe("validatePassword", () => {
  it("accepts 10..1024 char passwords", () => {
    expect(validatePassword("1234567890")).toBeNull();
    expect(validatePassword("a".repeat(1024))).toBeNull();
  });
  it("rejects too short / too long / non-string", () => {
    expect(validatePassword("123456789")).not.toBeNull(); // 9 chars
    expect(validatePassword("a".repeat(1025))).not.toBeNull();
    expect(validatePassword(1234567890)).not.toBeNull();
  });
});

describe("generateUserId", () => {
  it("has the usr_ + 24 hex shape and is unique per call", () => {
    const a = generateUserId();
    const b = generateUserId();
    expect(a).toMatch(/^usr_[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });
});

describe("session cookie helpers", () => {
  it("builds a __Host- cookie with the required attributes", () => {
    const c = buildSessionCookie("tok123", 3600);
    expect(c.startsWith(`${SESSION_COOKIE}=tok123;`)).toBe(true);
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=3600");
  });

  it("clear cookie expires immediately", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("parses our cookie out of a multi-cookie header, ignoring others", () => {
    const req = new Request("https://prism.test/", {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=abc.def; theme=dark` },
    });
    expect(parseSessionCookie(req)).toBe("abc.def");
  });

  it("returns null when the cookie is absent", () => {
    const req = new Request("https://prism.test/", { headers: { cookie: "other=1" } });
    expect(parseSessionCookie(req)).toBeNull();
    expect(parseSessionCookie(new Request("https://prism.test/"))).toBeNull();
  });

  it("generates a url-safe opaque token", () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThan(20);
  });
});

describe("login timing oracle guard", () => {
  it("the unknown-username dummy hash costs the same iterations as a real hash", () => {
    const parsed = parsePhc(DUMMY_PASSWORD_HASH);
    expect(parsed).not.toBeNull();
    // Parity with the real KDF cost is what closes the enumeration side channel.
    expect(parsed!.iterations).toBe(PBKDF2_ITERATIONS);
    expect(parsed!.salt.length).toBe(16);
    expect(parsed!.hash.length).toBe(32);
  });
});
