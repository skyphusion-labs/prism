// Tests for the audio beat-sync parser. Beat analysis now runs on the
// AUDIO_BEAT_SYNC Cloudflare Container (containers/audio-beat-sync emits the
// snake_case plan); parseAudioBeatPlan normalizes it to the camelCase Worker
// shape. The route handler (handleAudioAnalyze in src/index.ts) touches DO
// fetch + R2 presign and is not unit-tested here, matching the pure-helper
// pattern. See docs/audio-beat-sync-container.md.

import { describe, it, expect } from "vitest";
import { parseAudioBeatPlan } from "../src/runpod-submit";

describe("parseAudioBeatPlan", () => {
  it("parses a valid beat-mode response (snake -> camel)", () => {
    const raw = {
      mode: "beat", audio_key: "audio/track.mp3", duration_seconds: 248,
      bpm: 124.5, beat_count: 516, suggested_shots: 32, clip_seconds: 4,
      film_seconds: 248, remainder_seconds: 0,
      timed_scenes: [
        { index: 0, start: 0, end: 3.875, target_seconds: 3.88 },
        { index: 1, start: 3.875, end: 7.75, target_seconds: 3.88 },
      ],
      note: "Beat sync",
    };
    const plan = parseAudioBeatPlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("beat");
    expect(plan!.audioKey).toBe("audio/track.mp3");
    expect(plan!.bpm).toBe(124.5);
    expect(plan!.beatCount).toBe(516);
    expect(plan!.suggestedShots).toBe(32);
    expect(plan!.timedScenes).toHaveLength(2);
    expect(plan!.timedScenes[1]).toEqual({ index: 1, start: 3.875, end: 7.75, targetSeconds: 3.88 });
  });

  it("parses a valid duration-mode response with empty timed_scenes", () => {
    const plan = parseAudioBeatPlan({
      mode: "duration", audio_key: "audio/x.mp3", duration_seconds: 60,
      suggested_shots: 10, clip_seconds: 6, film_seconds: 60, remainder_seconds: 0,
      timed_scenes: [], note: "Duration",
    });
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("duration");
    expect(plan!.bpm).toBeUndefined();
    expect(plan!.timedScenes).toEqual([]);
  });

  it("returns null when mode is missing or wrong", () => {
    expect(parseAudioBeatPlan({ audio_key: "audio/x.mp3" })).toBeNull();
    expect(parseAudioBeatPlan({ mode: "nonsense" })).toBeNull();
    expect(parseAudioBeatPlan(null)).toBeNull();
    expect(parseAudioBeatPlan("not an object")).toBeNull();
  });

  it("drops malformed timed_scenes entries but keeps valid ones", () => {
    const plan = parseAudioBeatPlan({
      mode: "beat", timed_scenes: [
        { index: 0, start: 0, end: 4, target_seconds: 4 },
        null,
        "garbage",
        { start: 4, end: 8, target_seconds: 4 }, // missing index -> defaults to 0, still kept
      ],
    });
    expect(plan).not.toBeNull();
    // null + "garbage" filtered out; two object entries survive.
    expect(plan!.timedScenes).toHaveLength(2);
    expect(plan!.timedScenes[1].index).toBe(0); // missing index defaulted
  });
});
