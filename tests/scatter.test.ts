// Tests for the distributed scatter/gather conductor core (src/scatter.ts):
// the pure logic that splits a storyboard across N parallel jobs, shapes each
// shard's finish-offloaded submit args, and decides when the gather can merge.
// No I/O here, just the decisions that drive the orchestration in index.ts.

import { describe, it, expect } from "vitest";
import {
  splitShots,
  buildShardJobs,
  gatherDecision,
  scatterParentJobId,
  isScatterParentJobId,
} from "../src/scatter";

describe("splitShots", () => {
  it("splits into contiguous, front-loaded-balanced shards", () => {
    const shots = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"];
    expect(splitShots(shots, 3)).toEqual([
      ["s1", "s2", "s3", "s4"],
      ["s5", "s6", "s7"],
      ["s8", "s9", "s10"],
    ]);
  });

  it("preserves storyboard order and loses no shots", () => {
    const shots = Array.from({ length: 17 }, (_, i) => `shot_${i + 1}`);
    const shards = splitShots(shots, 4);
    expect(shards.flat()).toEqual(shots);
    // balanced: 17 over 4 => 5,4,4,4
    expect(shards.map((s) => s.length)).toEqual([5, 4, 4, 4]);
  });

  it("clamps shardCount to the shot count (no empty shards)", () => {
    const shots = ["a", "b", "c"];
    const shards = splitShots(shots, 10);
    expect(shards).toEqual([["a"], ["b"], ["c"]]);
    expect(shards.every((s) => s.length > 0)).toBe(true);
  });

  it("treats shardCount < 1 as a single shard", () => {
    expect(splitShots(["a", "b"], 0)).toEqual([["a", "b"]]);
  });

  it("returns [] for an empty / junk shot list", () => {
    expect(splitShots([], 3)).toEqual([]);
    expect(splitShots(["", "x", ""], 2)).toEqual([["x"]]);
  });
});

describe("buildShardJobs", () => {
  const base = {
    project: "neon",
    bundleKey: "bundles/neon.tar.gz",
    qualityTier: "draft" as const,
    pretrainedLoras: { A: "loras/neon/A/w.safetensors", B: "loras/neon/B/w.safetensors" },
    shotIds: ["s1", "s2", "s3", "s4"],
    shardCount: 2,
    userEmail: "conrad@example.com",
  };

  it("produces one finish-offloaded subset job per shard", () => {
    const jobs = buildShardJobs(base);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].processShotIds).toEqual(["s1", "s2"]);
    expect(jobs[1].processShotIds).toEqual(["s3", "s4"]);
    for (const j of jobs) {
      expect(j.renderOverrides?.finish_offloaded).toBe(true);
      expect(j.project).toBe("neon");
      expect(j.bundleKey).toBe("bundles/neon.tar.gz");
      expect(j.userEmail).toBe("conrad@example.com");
    }
  });

  it("hands every shard the pretrained LoRAs so no shard retrains", () => {
    const jobs = buildShardJobs(base);
    for (const j of jobs) expect(j.pretrainedLoras).toEqual(base.pretrainedLoras);
  });

  it("merges, does not clobber, caller render overrides", () => {
    const jobs = buildShardJobs({
      ...base,
      renderOverrides: { i2v: { steps: 8 }, finish_offloaded: false },
    });
    // caller's namespaced block survives; the routing flag is forced on
    expect(jobs[0].renderOverrides).toMatchObject({ i2v: { steps: 8 }, finish_offloaded: true });
  });

  it("scopes LoRAs per shard when shotSlots is given (no spare adapters)", () => {
    const jobs = buildShardJobs({
      ...base,
      shotIds: ["env1", "s_a", "s_b"],
      shardCount: 3,
      shotSlots: { env1: [], s_a: ["A"], s_b: ["B"] },
    });
    expect(jobs[0].pretrainedLoras).toBeUndefined(); // env-only shard: no LoRA staged
    expect(jobs[1].pretrainedLoras).toEqual({ A: base.pretrainedLoras.A });
    expect(jobs[2].pretrainedLoras).toEqual({ B: base.pretrainedLoras.B });
  });
});

describe("gatherDecision", () => {
  const running = [{ status: "IN_PROGRESS" }, { status: "COMPLETED" }];

  it("finishes once every shot has a clip", () => {
    expect(gatherDecision(["s1", "s2", "s3"], [], running)).toEqual({ kind: "finish" });
  });

  it("waits while clips are still landing", () => {
    expect(gatherDecision(["s1"], ["s2", "s3"], running)).toEqual({ kind: "waiting", remaining: 2 });
  });

  it("fails when a shard is dead and its shots are still missing", () => {
    const d = gatherDecision(["s1"], ["s2"], [{ status: "FAILED" }, { status: "COMPLETED" }]);
    expect(d.kind).toBe("failed");
  });

  it("does NOT finish on an empty render (no present, no missing)", () => {
    expect(gatherDecision([], [], running).kind).toBe("waiting");
  });
});

describe("scatter parent job id", () => {
  it("round-trips the synthetic marker", () => {
    const id = scatterParentJobId("abc123");
    expect(id).toBe("scatter-abc123");
    expect(isScatterParentJobId(id)).toBe(true);
    expect(isScatterParentJobId("475feed1-runpod")).toBe(false);
    expect(isScatterParentJobId(null)).toBe(false);
  });
});
