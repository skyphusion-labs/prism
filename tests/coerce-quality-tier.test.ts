import { describe, it, expect } from "vitest";
import { coerceQualityTier } from "../src/runpod-submit";

// The real tiers are keyframe (a separate keyframesOnly flag), draft, and final.
// "standard" was vestigial (the pod's for_tier only branches draft vs final) and is
// removed; it must still coerce to "final" so old History rows / clients never 400.
describe("coerceQualityTier", () => {
  it("passes draft and final through", () => {
    expect(coerceQualityTier("draft")).toBe("draft");
    expect(coerceQualityTier("final")).toBe("final");
  });

  it("coerces the legacy 'standard' tier to 'final'", () => {
    expect(coerceQualityTier("standard")).toBe("final");
  });

  it("returns undefined for absent or invalid tiers", () => {
    expect(coerceQualityTier(undefined)).toBeUndefined();
    expect(coerceQualityTier("")).toBeUndefined();
    expect(coerceQualityTier("ultra")).toBeUndefined();
    expect(coerceQualityTier(3)).toBeUndefined();
    expect(coerceQualityTier(null)).toBeUndefined();
  });
});
