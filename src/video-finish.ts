// Video-finish orchestration (v0.120.0).
//
// Presigns the per-shot clips + optional soundtrack (R2 GET) and the final MP4
// (R2 PUT), then calls the VIDEO_FINISH Cloudflare Container's /finish endpoint
// with a cold-start guard. The container does the ffmpeg work (concat / xfade /
// audio mux); bytes never touch the Worker. Mirrors the bundle-assembler
// callImagePrep pattern. Pure-ish: only touches env (presign + container stub).

import type { Env } from "./env";
import { presignR2Get, presignR2Put } from "./r2-presign";
import { renderSlug } from "./render-progress";

export interface VideoFinishClip {
  key: string;
  targetSeconds?: number;
}

export interface VideoFinishInput {
  clips: VideoFinishClip[];
  audioKey?: string;
  outputKey: string;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  preset?: string;
  crossfade?: number;
  trimJoinFrames?: number;
  // v0.155.0: add audio to a single already-finished MP4 without re-encoding or
  // re-scaling the video (stream-copy). Used by add-audio / add-narration so a
  // 1280x720 hybrid/cloud render keeps its resolution instead of being upscaled
  // to the container's 1080p normalize default.
  remuxAudioOnly?: boolean;
}

const MAX_CLIPS = 80;

// Validate a /api/video/finish request body. Keeps the route handler thin and
// gives the unit tests a pure target.
export function parseVideoFinishInput(
  raw: unknown,
): { ok: true; value: VideoFinishInput } | { ok: false; errors: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["body must be an object"] };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.clips) || o.clips.length === 0) {
    return { ok: false, errors: ["clips must be a non-empty array"] };
  }
  if (o.clips.length > MAX_CLIPS) {
    return { ok: false, errors: [`too many clips (>${MAX_CLIPS})`] };
  }
  const clips: VideoFinishClip[] = [];
  for (let i = 0; i < o.clips.length; i++) {
    const c = o.clips[i];
    // Accept either a bare R2 key string or { key, targetSeconds }.
    if (typeof c === "string") {
      if (!c) return { ok: false, errors: [`clips[${i}] is empty`] };
      clips.push({ key: c });
      continue;
    }
    if (c === null || typeof c !== "object") {
      return { ok: false, errors: [`clips[${i}] must be a key string or {key, targetSeconds}`] };
    }
    const key = (c as { key?: unknown }).key;
    if (typeof key !== "string" || !key) {
      return { ok: false, errors: [`clips[${i}].key must be a non-empty string`] };
    }
    const ts = (c as { targetSeconds?: unknown }).targetSeconds;
    const clip: VideoFinishClip = { key };
    if (ts !== undefined) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
        return { ok: false, errors: [`clips[${i}].targetSeconds must be a positive number`] };
      }
      clip.targetSeconds = ts;
    }
    clips.push(clip);
  }
  if (typeof o.outputKey !== "string" || !o.outputKey) {
    return { ok: false, errors: ["outputKey must be a non-empty string"] };
  }
  const out: VideoFinishInput = { clips, outputKey: o.outputKey };
  if (o.audioKey !== undefined) {
    if (typeof o.audioKey !== "string" || !o.audioKey) {
      return { ok: false, errors: ["audioKey must be a non-empty string when provided"] };
    }
    out.audioKey = o.audioKey;
  }
  for (const k of ["width", "height", "fps", "crf", "crossfade", "trimJoinFrames"] as const) {
    const v = o[k];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return { ok: false, errors: [`${k} must be a non-negative number`] };
      }
      out[k] = v;
    }
  }
  if (o.preset !== undefined) {
    if (typeof o.preset !== "string") {
      return { ok: false, errors: ["preset must be a string"] };
    }
    out.preset = o.preset;
  }
  if (o.remuxAudioOnly !== undefined) {
    if (typeof o.remuxAudioOnly !== "boolean") {
      return { ok: false, errors: ["remuxAudioOnly must be a boolean"] };
    }
    if (o.remuxAudioOnly && clips.length !== 1) {
      return { ok: false, errors: ["remuxAudioOnly requires exactly one clip"] };
    }
    out.remuxAudioOnly = o.remuxAudioOnly;
  }
  return { ok: true, value: out };
}

// Map the pod's off-GPU finish manifest (rp_handler's job output, snake_case)
// into a VideoFinishInput. Returns null if the manifest is unusable (no clips /
// no output_key). The pod sets output_key to the DESIRED final key. finish_params
// is snake_case (trim_join_frames); we translate to the container's camelCase.
export function finishInputFromPodOutput(out: Record<string, unknown>): VideoFinishInput | null {
  const clipsRaw = out.clips;
  if (!Array.isArray(clipsRaw) || clipsRaw.length === 0) return null;
  const clips: VideoFinishClip[] = [];
  for (const c of clipsRaw) {
    if (!c || typeof c !== "object") return null;
    const key = (c as { key?: unknown }).key;
    if (typeof key !== "string" || !key) return null;
    const clip: VideoFinishClip = { key };
    const ts = (c as { target_seconds?: unknown }).target_seconds;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) clip.targetSeconds = ts;
    clips.push(clip);
  }
  // The pod sets output_key to the desired final key. An OFFLOADED render leaves it
  // unset (it emits per-shot clips for the off-GPU merge), so derive the canonical
  // <prefix>/full.mp4 from the clips' shared renders/<project>/clips/ prefix.
  let outputKey = typeof out.output_key === "string" && out.output_key ? out.output_key : "";
  if (!outputKey) {
    const i = clips[0].key.lastIndexOf("/clips/");
    if (i < 0) return null;  // clips not in the expected renders/<project>/clips/ layout
    outputKey = clips[0].key.slice(0, i) + "/full.mp4";
  }
  const input: VideoFinishInput = { clips, outputKey };
  if (typeof out.audio_key === "string" && out.audio_key) input.audioKey = out.audio_key;
  const fp = (out.finish_params && typeof out.finish_params === "object" && !Array.isArray(out.finish_params)
    ? (out.finish_params as Record<string, unknown>)
    : {});
  const n = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (n(fp.width) !== undefined) input.width = fp.width as number;
  if (n(fp.height) !== undefined) input.height = fp.height as number;
  if (n(fp.fps) !== undefined) input.fps = fp.fps as number;
  if (n(fp.crf) !== undefined) input.crf = fp.crf as number;
  if (n(fp.crossfade) !== undefined) input.crossfade = fp.crossfade as number;
  if (n(fp.trim_join_frames) !== undefined) input.trimJoinFrames = fp.trim_join_frames as number;
  if (typeof fp.preset === "string") input.preset = fp.preset;
  return input;
}

// v0.159.0 (item D): the canonical R2 keys for a render's per-shot clips and final
// MP4, byte-identical to the backend's keys.clip_key + the <prefix>/full.mp4 layout
// (renders/<slug>/clips/<shot_id>.mp4, renders/<slug>/full.mp4). renderSlug mirrors
// the backend _slug, so these address the SAME objects N independent shot-jobs write.
export function clipKey(project: string, shotId: string): string {
  return `renders/${renderSlug(project)}/clips/${shotId}.mp4`;
}

export function finishOutputKey(project: string): string {
  return `renders/${renderSlug(project)}/full.mp4`;
}

// v0.159.0 (item D): finish params for the multi-job gather (same knobs the pod's
// finish_params carry; all optional, the container has defaults).
export interface GatherFinishOpts {
  audioKey?: string;
  targetSeconds?: Record<string, number>;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  preset?: string;
  crossfade?: number;
  trimJoinFrames?: number;
}

// v0.159.0 (item D): build a VideoFinishInput for the SCATTER/GATHER finish. Unlike
// finishInputFromPodOutput (one job's manifest), this addresses the clips directly by
// project + the storyboard's shot order, so it merges whatever N shot-jobs wrote to
// the canonical clip keys -- no single job owns all the clips. `orderedShotIds` MUST
// already be in storyboard order (the container concats in array order). Per-shot
// `targetSeconds` is optional (the container derives duration from the clip when
// absent). Returns null on an empty / malformed shot list.
export function finishInputFromClipKeys(
  project: string,
  orderedShotIds: string[],
  opts: GatherFinishOpts = {},
): VideoFinishInput | null {
  if (!Array.isArray(orderedShotIds) || orderedShotIds.length === 0) return null;
  const clips: VideoFinishClip[] = [];
  for (const shotId of orderedShotIds) {
    if (typeof shotId !== "string" || !shotId) return null;
    const clip: VideoFinishClip = { key: clipKey(project, shotId) };
    const ts = opts.targetSeconds?.[shotId];
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) clip.targetSeconds = ts;
    clips.push(clip);
  }
  const input: VideoFinishInput = { clips, outputKey: finishOutputKey(project) };
  if (opts.audioKey) input.audioKey = opts.audioKey;
  if (typeof opts.width === "number" && Number.isFinite(opts.width)) input.width = opts.width;
  if (typeof opts.height === "number" && Number.isFinite(opts.height)) input.height = opts.height;
  if (typeof opts.fps === "number" && Number.isFinite(opts.fps)) input.fps = opts.fps;
  if (typeof opts.crf === "number" && Number.isFinite(opts.crf)) input.crf = opts.crf;
  if (typeof opts.preset === "string") input.preset = opts.preset;
  if (typeof opts.crossfade === "number" && Number.isFinite(opts.crossfade)) input.crossfade = opts.crossfade;
  if (typeof opts.trimJoinFrames === "number" && Number.isFinite(opts.trimJoinFrames)) {
    input.trimJoinFrames = opts.trimJoinFrames;
  }
  return input;
}

// v0.159.0 (item D): the gather signal -- which of the storyboard's shots already
// have a clip in R2. A scatter render is finishable when every shot is present.
// Uses R2_RENDERS.head (cheap, no body). Order of the returned lists is not
// significant; the caller orders by the storyboard before building the finish input.
export async function gatherClipPresence(
  env: Env,
  project: string,
  shotIds: string[],
): Promise<{ present: string[]; missing: string[] }> {
  const present: string[] = [];
  const missing: string[] = [];
  await Promise.all(
    shotIds.map(async (shotId) => {
      const head = await env.R2_RENDERS.head(clipKey(project, shotId)).catch(() => null);
      (head ? present : missing).push(shotId);
    }),
  );
  return { present, missing };
}

// Whether a completed render's output is an OFF-GPU-finish job needing the merge:
// per-shot clips with no merged output_key (a normal render is the inverse -- it
// has output_key set and no clips). Accepts the explicit finish_offloaded flag too,
// though the clean-room pod does not currently stamp it, so the shape is what fires
// the auto-finish in resolveOffloadedFinish.
export function isOffloadedRenderOutput(out: Record<string, unknown> | null | undefined): boolean {
  if (!out) return false;
  if (out.finish_offloaded === true) return true;
  return Array.isArray(out.clips) && out.clips.length > 0 && !out.output_key;
}

// Call the container's /finish with the same cold-start guard as callImagePrep:
// a cheap /health warms the bind window, then retry the heavy /finish on a 503.
// Returns the container Response, or null on a network error.
export async function callVideoFinish(
  env: Env,
  payload: unknown,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const stub = env.VIDEO_FINISH.get(env.VIDEO_FINISH.idFromName("singleton"));
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  try {
    await stub.fetch("https://container/health");
  } catch {
    /* best effort; the retry loop below still covers a cold start */
  }
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await stub.fetch("https://container/finish", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503) return resp;
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  return resp;
}

// Presign every input/output and drive the container. Presign TTL is generous
// (the ffmpeg encode of a long film can take a while) but still short-lived.
export async function runVideoFinish(
  env: Env,
  input: VideoFinishInput,
  opts: { ttlSeconds?: number; retries?: number; backoffMs?: number } = {},
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; error: string }> {
  const ttl = opts.ttlSeconds ?? 900;
  const clipUrls = await Promise.all(
    input.clips.map(async (c) => ({
      url: await presignR2Get(env, c.key, ttl),
      ...(c.targetSeconds !== undefined ? { targetSeconds: c.targetSeconds } : {}),
    })),
  );
  const audioUrl = input.audioKey ? await presignR2Get(env, input.audioKey, ttl) : undefined;
  const outputUrl = await presignR2Put(env, input.outputKey, ttl);

  const payload = {
    clips: clipUrls,
    ...(audioUrl ? { audioUrl } : {}),
    outputUrl,
    outputKey: input.outputKey,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {}),
    ...(input.crf !== undefined ? { crf: input.crf } : {}),
    ...(input.preset !== undefined ? { preset: input.preset } : {}),
    ...(input.crossfade !== undefined ? { crossfade: input.crossfade } : {}),
    ...(input.trimJoinFrames !== undefined ? { trimJoinFrames: input.trimJoinFrames } : {}),
    ...(input.remuxAudioOnly ? { remuxAudioOnly: true } : {}),
  };

  const resp = await callVideoFinish(env, payload, opts);
  if (!resp) {
    return { ok: false, status: 502, error: "video-finish container unreachable" };
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return { ok: false, status: 502, error: `non-JSON from container (status ${resp.status}): ${text.slice(0, 300)}` };
  }
  if (!resp.ok || (body as { ok?: boolean })?.ok === false) {
    const err = (body as { error?: string })?.error || `container status ${resp.status}`;
    return { ok: false, status: resp.status === 200 ? 500 : resp.status, error: err };
  }
  return { ok: true, result: body };
}
