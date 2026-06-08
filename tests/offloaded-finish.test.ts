import { describe, it, expect } from "vitest";
import { isOffloadedRenderOutput, finishInputFromPodOutput } from "../src/video-finish";

// A pure-shape model of the two render outputs the pod produces:
//  - offloaded: per-shot clips, NO merged output_key (the clean-room pod does not
//    stamp finish_offloaded either) -> the control plane must run the off-GPU merge.
//  - normal:    a merged output_key, no clips -> nothing to finish (passthrough).
describe("isOffloadedRenderOutput", () => {
  it("recognizes the offloaded shape (clips, no output_key)", () => {
    expect(isOffloadedRenderOutput({
      clips: [{ key: "renders/p/clips/shot_01.mp4", shot_id: "shot_01" }],
    })).toBe(true);
  });

  it("treats a normal merged render as not offloaded (output_key set, no clips)", () => {
    expect(isOffloadedRenderOutput({ output_key: "renders/p/full.mp4" })).toBe(false);
  });

  it("accepts the explicit finish_offloaded flag too", () => {
    expect(isOffloadedRenderOutput({ finish_offloaded: true, clips: [{ key: "x" }] })).toBe(true);
  });

  it("is false for null / empty clips / no usable shape", () => {
    expect(isOffloadedRenderOutput(null)).toBe(false);
    expect(isOffloadedRenderOutput({ clips: [] })).toBe(false);
    expect(isOffloadedRenderOutput({})).toBe(false);
  });
});

describe("finishInputFromPodOutput derives the target when the pod omits output_key", () => {
  it("derives renders/<project>/full.mp4 from the clips' /clips/ prefix", () => {
    const input = finishInputFromPodOutput({
      project: "neon-finish-verify",
      clips: [
        { key: "renders/neon-finish-verify/clips/shot_01.mp4", shot_id: "shot_01" },
        { key: "renders/neon-finish-verify/clips/shot_02.mp4", shot_id: "shot_02" },
      ],
    });
    expect(input).not.toBeNull();
    expect(input!.outputKey).toBe("renders/neon-finish-verify/full.mp4");
    expect(input!.clips.map((c) => c.key)).toEqual([
      "renders/neon-finish-verify/clips/shot_01.mp4",
      "renders/neon-finish-verify/clips/shot_02.mp4",
    ]);
  });

  it("uses an explicit output_key when the pod provides one (cloud/hybrid path)", () => {
    const input = finishInputFromPodOutput({
      output_key: "renders/p/full-abc.mp4",
      clips: [{ key: "renders/p/clips/shot_01.mp4" }],
    });
    expect(input!.outputKey).toBe("renders/p/full-abc.mp4");
  });

  it("returns null when clips are not in the expected /clips/ layout and no output_key", () => {
    expect(finishInputFromPodOutput({ clips: [{ key: "weird/path.mp4" }] })).toBeNull();
  });
});
