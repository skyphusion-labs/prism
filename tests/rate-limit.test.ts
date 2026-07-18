// Pure-logic tests for the rate-limit window decision (v0.167.0, issue #80).

import { describe, expect, it } from "vitest";
import { rateLimitDecision } from "../src/rate-limit";

const LIMIT = 5;
const WINDOW = 900; // 15 min

describe("rateLimitDecision", () => {
  it("allows and opens a fresh window when no prior record", () => {
    const d = rateLimitDecision(1000, null, 0, LIMIT, WINDOW);
    expect(d).toEqual({ allowed: true, nextCount: 1, nextWindowStart: 1000 });
  });

  it("increments within a live window and allows up to the limit", () => {
    // 4 prior attempts, this is the 5th -> still allowed at the limit.
    const d = rateLimitDecision(1100, 1000, 4, LIMIT, WINDOW);
    expect(d.allowed).toBe(true);
    expect(d.nextCount).toBe(5);
    expect(d.nextWindowStart).toBe(1000);
  });

  it("denies once the count would exceed the limit", () => {
    const d = rateLimitDecision(1100, 1000, 5, LIMIT, WINDOW);
    expect(d.allowed).toBe(false);
    expect(d.nextCount).toBe(6);
    expect(d.nextWindowStart).toBe(1000);
  });

  it("resets to a fresh window once the window has fully elapsed", () => {
    const d = rateLimitDecision(1000 + WINDOW, 1000, 5, LIMIT, WINDOW);
    expect(d).toEqual({ allowed: true, nextCount: 1, nextWindowStart: 1000 + WINDOW });
  });

  it("denied attempts still count, keeping the bucket closed until rollover", () => {
    let count = 5;
    const start = 1000;
    for (let i = 0; i < 3; i++) {
      const d = rateLimitDecision(1200, start, count, LIMIT, WINDOW);
      expect(d.allowed).toBe(false);
      count = d.nextCount;
    }
    expect(count).toBe(8);
  });
});
