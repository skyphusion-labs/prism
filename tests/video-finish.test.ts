import { describe, expect, it, vi } from "vitest";
import {
  callVideoFinish,
  clipKey,
  finishInputFromClipKeys,
  finishOutputKey,
  finishInputFromPodOutput,
  gatherClipPresence,
  parseVideoFinishInput,
} from "../src/video-finish";
import type { Env } from "../src/env";

describe("parseVideoFinishInput", () => {
  it("accepts bare key strings and {key,targetSeconds}", () => {
    const r = parseVideoFinishInput({
      clips: ["renders/p/clips/shot_01.mp4", { key: "renders/p/clips/shot_02.mp4", targetSeconds: 4.5 }],
      audioKey: "audio/x.mp3",
      outputKey: "renders/p/full.mp4",
      crossfade: 0.5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.clips).toEqual([
        { key: "renders/p/clips/shot_01.mp4" },
        { key: "renders/p/clips/shot_02.mp4", targetSeconds: 4.5 },
      ]);
      expect(r.value.audioKey).toBe("audio/x.mp3");
      expect(r.value.crossfade).toBe(0.5);
    }
  });

  it("works with no audio (silent finish)", () => {
    const r = parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "out.mp4" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.audioKey).toBeUndefined();
  });

  it("rejects empty / non-array clips", () => {
    expect(parseVideoFinishInput({ clips: [], outputKey: "o" }).ok).toBe(false);
    expect(parseVideoFinishInput({ outputKey: "o" }).ok).toBe(false);
  });

  it("rejects missing outputKey", () => {
    expect(parseVideoFinishInput({ clips: ["a.mp4"] }).ok).toBe(false);
  });

  it("rejects a clip with non-positive targetSeconds", () => {
    expect(parseVideoFinishInput({ clips: [{ key: "a.mp4", targetSeconds: 0 }], outputKey: "o" }).ok).toBe(false);
  });

  it("rejects a bad preset / numeric type", () => {
    expect(parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "o", crf: "18" }).ok).toBe(false);
    expect(parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "o", preset: 5 }).ok).toBe(false);
  });

  it("accepts remuxAudioOnly with a single clip and carries it through", () => {
    const r = parseVideoFinishInput({
      clips: ["render.mp4"],
      outputKey: "o",
      audioKey: "audio/bed.mp3",
      remuxAudioOnly: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.remuxAudioOnly).toBe(true);
  });

  it("rejects remuxAudioOnly with more than one clip", () => {
    expect(
      parseVideoFinishInput({ clips: ["a.mp4", "b.mp4"], outputKey: "o", remuxAudioOnly: true }).ok,
    ).toBe(false);
  });

  it("rejects a non-boolean remuxAudioOnly", () => {
    expect(
      parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "o", remuxAudioOnly: "yes" }).ok,
    ).toBe(false);
  });
});

describe("finishInputFromPodOutput", () => {
  const podOut = {
    finish_offloaded: true,
    output_key: "renders/p/full-abc123.mp4",
    audio_key: "audio/track.mp3",
    clips: [
      { key: "renders/p/job/clips/shot_01.mp4", shot_id: "shot_01", target_seconds: 6.04 },
      { key: "renders/p/job/clips/shot_02.mp4", shot_id: "shot_02" },
    ],
    finish_params: {
      width: 1920, height: 1080, fps: 24, crf: 18, preset: "medium",
      crossfade: 0.5, trim_join_frames: 1,
    },
  };

  it("maps the pod manifest (snake_case) to a VideoFinishInput (camelCase)", () => {
    const input = finishInputFromPodOutput(podOut);
    expect(input).not.toBeNull();
    if (!input) return;
    expect(input.outputKey).toBe("renders/p/full-abc123.mp4");
    expect(input.audioKey).toBe("audio/track.mp3");
    expect(input.clips).toEqual([
      { key: "renders/p/job/clips/shot_01.mp4", targetSeconds: 6.04 },
      { key: "renders/p/job/clips/shot_02.mp4" },
    ]);
    expect(input.width).toBe(1920);
    expect(input.crossfade).toBe(0.5);
    expect(input.trimJoinFrames).toBe(1); // snake trim_join_frames -> camel
    expect(input.preset).toBe("medium");
  });

  it("works with no audio", () => {
    const input = finishInputFromPodOutput({ ...podOut, audio_key: undefined });
    expect(input?.audioKey).toBeUndefined();
  });

  it("derives the target from the clips prefix when output_key is missing; null on empty/keyless clips", () => {
    // v0.156.2: an offloaded render omits output_key, so derive renders/<prefix>/full.mp4
    // from the clips' shared /clips/ prefix instead of rejecting it.
    expect(finishInputFromPodOutput({ ...podOut, output_key: undefined })?.outputKey)
      .toBe("renders/p/job/full.mp4");
    expect(finishInputFromPodOutput({ ...podOut, clips: [] })).toBeNull();
    expect(finishInputFromPodOutput({ ...podOut, clips: [{ shot_id: "x" }] })).toBeNull();
  });
});

// Fake DO stub so callVideoFinish's cold-start guard is testable without a real
// container. /health always 200; /finish returns the queued sequence of statuses.
function fakeEnv(finishStatuses: number[]): { env: Env; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const stub = {
    fetch: vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      const status = finishStatuses[Math.min(i, finishStatuses.length - 1)];
      i++;
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }),
  };
  const env = {
    VIDEO_FINISH: { idFromName: () => "id", get: () => stub },
  } as unknown as Env;
  return { env, calls };
}

describe("callVideoFinish cold-start guard", () => {
  it("warms /health then succeeds on first /finish", async () => {
    const { env, calls } = fakeEnv([200]);
    const resp = await callVideoFinish(env, {}, { backoffMs: 0 });
    expect(resp?.status).toBe(200);
    expect(calls[0]).toContain("/health");
    expect(calls[1]).toContain("/finish");
  });

  it("retries /finish on 503 then returns the 200", async () => {
    const { env, calls } = fakeEnv([503, 503, 200]);
    const resp = await callVideoFinish(env, {}, { backoffMs: 0, retries: 3 });
    expect(resp?.status).toBe(200);
    // 1 health + 3 finish attempts
    expect(calls.filter((c) => c.endsWith("/finish")).length).toBe(3);
  });

  it("gives up after retries exhausted on persistent 503", async () => {
    const { env } = fakeEnv([503]);
    const resp = await callVideoFinish(env, {}, { backoffMs: 0, retries: 2 });
    expect(resp?.status).toBe(503);
  });
});

// item D: the scatter/gather multi-job finish core.
describe("clipKey / finishOutputKey (canonical R2 layout)", () => {
  it("mirrors the backend keys.clip_key + <prefix>/full.mp4 layout, slugging the project", () => {
    expect(clipKey("neon rain", "shot_03")).toBe("renders/neon_rain/clips/shot_03.mp4");
    expect(finishOutputKey("neon rain")).toBe("renders/neon_rain/full.mp4");
  });
});

describe("finishInputFromClipKeys (multi-job gather assembler)", () => {
  it("builds clips in the given storyboard order + the canonical output key", () => {
    const input = finishInputFromClipKeys("my_film", ["shot_01", "shot_02", "shot_03"]);
    expect(input).not.toBeNull();
    expect(input!.clips.map((c) => c.key)).toEqual([
      "renders/my_film/clips/shot_01.mp4",
      "renders/my_film/clips/shot_02.mp4",
      "renders/my_film/clips/shot_03.mp4",
    ]);
    expect(input!.outputKey).toBe("renders/my_film/full.mp4");
  });

  it("attaches per-shot targetSeconds when provided, omits otherwise", () => {
    const input = finishInputFromClipKeys("f", ["a", "b"], { targetSeconds: { a: 5.5 } });
    expect(input!.clips[0]).toEqual({ key: "renders/f/clips/a.mp4", targetSeconds: 5.5 });
    expect(input!.clips[1]).toEqual({ key: "renders/f/clips/b.mp4" });
  });

  it("passes audioKey + finish params through", () => {
    const input = finishInputFromClipKeys("f", ["a"], {
      audioKey: "audio/x.mp3", width: 1920, height: 1080, fps: 16, crf: 18, crossfade: 0.45,
    });
    expect(input!.audioKey).toBe("audio/x.mp3");
    expect(input!.width).toBe(1920);
    expect(input!.crossfade).toBe(0.45);
  });

  it("returns null on an empty or malformed shot list", () => {
    expect(finishInputFromClipKeys("f", [])).toBeNull();
    expect(finishInputFromClipKeys("f", ["a", "" as string])).toBeNull();
  });
});

describe("gatherClipPresence (the gather signal)", () => {
  const envWith = (presentKeys: Set<string>): Env =>
    ({ R2_RENDERS: { head: (k: string) => Promise.resolve(presentKeys.has(k) ? { key: k } : null) } } as unknown as Env);

  it("splits the shots into present + missing by R2 head", async () => {
    const env = envWith(new Set(["renders/f/clips/a.mp4", "renders/f/clips/c.mp4"]));
    const { present, missing } = await gatherClipPresence(env, "f", ["a", "b", "c"]);
    expect(present.sort()).toEqual(["a", "c"]);
    expect(missing).toEqual(["b"]);
  });

  it("treats a head() rejection as missing (never throws)", async () => {
    const env = { R2_RENDERS: { head: () => Promise.reject(new Error("r2 down")) } } as unknown as Env;
    const { present, missing } = await gatherClipPresence(env, "f", ["a"]);
    expect(present).toEqual([]);
    expect(missing).toEqual(["a"]);
  });
});
