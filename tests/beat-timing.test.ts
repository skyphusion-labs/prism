import { describe, expect, it } from "vitest";
import {
  applyBeatTiming,
  buildBeatTimingBlock,
  parseBeatTimingInput,
  type BeatTimingInput,
} from "../src/beat-timing";
import type { StoryboardValidated } from "../src/storyboard-validate";

// A realistic beat plan shaped like /api/audio/analyze's `output`.
const PLAN = {
  timedScenes: [
    { index: 0, start: 0, end: 4.04, targetSeconds: 4.04 },
    { index: 1, start: 4.04, end: 8.545, targetSeconds: 4.505 },
    { index: 2, start: 8.545, end: 13.026, targetSeconds: 4.481 },
  ],
  filmSeconds: 13.026,
  clipSeconds: 4,
  // extra fields the client may forward verbatim; must be ignored:
  bpm: 117.5,
  note: "Beat sync",
};

function sb(sceneCount: number): StoryboardValidated {
  return {
    title: "t",
    projectName: "t",
    full_prompt: "",
    duration_seconds: undefined,
    clip_seconds: undefined,
    style_prefix: "cinematic",
    style_category: "None",
    style_preset: "None",
    use_characters: ["A"],
    cast_rules: "",
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      prompt: `shot ${i + 1}`,
      character_slots: ["A" as const],
      act: "rising",
    })),
  };
}

describe("parseBeatTimingInput", () => {
  it("accepts a valid plan and ignores extra fields", () => {
    const r = parseBeatTimingInput(PLAN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timedScenes).toHaveLength(3);
      expect(r.value.filmSeconds).toBe(13.026);
      expect(r.value.clipSeconds).toBe(4);
      // not carried over:
      expect((r.value as unknown as { bpm?: number }).bpm).toBeUndefined();
    }
  });

  it("rejects non-object", () => {
    expect(parseBeatTimingInput(null).ok).toBe(false);
    expect(parseBeatTimingInput([]).ok).toBe(false);
    expect(parseBeatTimingInput("x").ok).toBe(false);
  });

  it("rejects empty timedScenes", () => {
    expect(parseBeatTimingInput({ timedScenes: [] }).ok).toBe(false);
  });

  it("rejects a scene with end <= start", () => {
    const r = parseBeatTimingInput({
      timedScenes: [{ index: 0, start: 5, end: 5, targetSeconds: 3 }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a scene with non-finite numbers", () => {
    const r = parseBeatTimingInput({
      timedScenes: [{ index: 0, start: 0, end: "4", targetSeconds: 4 }],
    });
    expect(r.ok).toBe(false);
  });

  it("omits optional filmSeconds/clipSeconds when absent or non-positive", () => {
    const r = parseBeatTimingInput({
      timedScenes: [{ index: 0, start: 0, end: 4, targetSeconds: 4 }],
      clipSeconds: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.filmSeconds).toBeUndefined();
      expect(r.value.clipSeconds).toBeUndefined();
    }
  });
});

describe("buildBeatTimingBlock", () => {
  it("pins the exact shot count and lists per-shot durations", () => {
    const beat = (parseBeatTimingInput(PLAN) as { value: BeatTimingInput }).value;
    const block = buildBeatTimingBlock(beat);
    expect(block).toContain("EXACTLY 3 scenes");
    expect(block).toContain("shot 1: ~4.04s");
    expect(block).toContain("shot 3: ~4.481s");
    expect(block).toContain("13.026s");
    // the model must NOT be asked to emit timing itself
    expect(block).toContain("do not emit start / end / target_seconds");
  });
});

describe("applyBeatTiming", () => {
  it("stamps exact timings when the count matches, with no warnings", () => {
    const beat = (parseBeatTimingInput(PLAN) as { value: BeatTimingInput }).value;
    const { storyboard, warnings } = applyBeatTiming(sb(3), beat);
    expect(warnings).toHaveLength(0);
    expect(storyboard.duration_seconds).toBe(13.026);
    expect(storyboard.clip_seconds).toBe(4);
    expect(storyboard.scenes.map((s) => s.target_seconds)).toEqual([4.04, 4.505, 4.481]);
    expect(storyboard.scenes.map((s) => s.start)).toEqual([0, 4.04, 8.545]);
    expect(storyboard.scenes.map((s) => s.end)).toEqual([4.04, 8.545, 13.026]);
    // content preserved
    expect(storyboard.scenes[0].prompt).toBe("shot 1");
  });

  it("truncates extra scenes and warns when the model overproduces", () => {
    const beat = (parseBeatTimingInput(PLAN) as { value: BeatTimingInput }).value;
    const { storyboard, warnings } = applyBeatTiming(sb(5), beat);
    expect(storyboard.scenes).toHaveLength(3);
    expect(warnings[0]).toContain("dropped the last 2");
  });

  it("warns (does not throw) when the model underproduces", () => {
    const beat = (parseBeatTimingInput(PLAN) as { value: BeatTimingInput }).value;
    const { storyboard, warnings } = applyBeatTiming(sb(2), beat);
    expect(storyboard.scenes).toHaveLength(2);
    expect(warnings[0]).toContain("will not fill the audio");
    // duration only claims what was actually covered (2 shots -> 8.545s)
    expect(storyboard.duration_seconds).toBe(8.545);
  });

  it("falls back to median target for clip_seconds when the plan omits clipSeconds", () => {
    const r = parseBeatTimingInput({
      timedScenes: [
        { index: 0, start: 0, end: 3, targetSeconds: 3 },
        { index: 1, start: 3, end: 8, targetSeconds: 5 },
        { index: 2, start: 8, end: 12, targetSeconds: 4 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const { storyboard } = applyBeatTiming(sb(3), r.value);
      expect(storyboard.clip_seconds).toBe(4); // median of [3,4,5]
    }
  });
});
