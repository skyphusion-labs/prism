# Vivijure studio: making a music video, end to end

A practical walkthrough of the whole pipeline, from an empty project to a scored
MP4. Vivijure studio is the storyboard/render control plane built into this
Worker; the GPU work happens on the separate
[`vivijure-serverless`](https://github.com/SkyPhusion/vivijure-serverless) RunPod
backend. For the architecture and the API surface, see the README
["Vivijure studio"](../README.md#vivijure-studio-ai-music-video-pipeline) section;
this doc is the hands-on guide.

## Entry points

Both are gated by the same Cloudflare Access login:

- **`vivijure.skyphusion.org`** -- the branded entry; lands straight on the planner.
- **`skyphusion.org/planner.html`** -- the same planner inside the main playground.
  The cast builder is **`skyphusion.org/cast.html`**.

## The pipeline at a glance

The planner has a stepper across the top:

**Plan -> Cast & Bundle -> Audio -> Render -> History**

You do not have to follow it strictly (Plan and History are always open; Cast/Audio
unlock once a storyboard exists; Render unlocks once a bundle is staged), but the
natural order, with **one important exception for beat-synced films** (see step 3),
is top to bottom. The short version:

1. **Build a cast** (optional but recommended) in the cast builder.
2. **Plan** the film into a validated storyboard.
3. **Beat-sync the audio** so cuts land on the music *(do this before you bundle)*.
4. **Assemble a bundle** (storyboard + cast).
5. **Render** -- usually a fast **keyframes-only preview** first.
6. **Put it in motion** from History: GPU Wan, cloud i2v, or hybrid.
7. **Score it** by muxing music or narration onto the silent cut.

---

## 1. Build your cast (`cast.html`)

Characters give the renderer consistent, identity-locked people across shots. Skip
this only for character-free / abstract films.

For each character (**+ new character**):

- **Name** and a **bible** -- a description of face, hair, body, wardrobe, signature
  props, mood. This text feeds both SDXL keyframe generation and LoRA training, so
  be concrete and visual.
- **Portrait** -- upload one, or **generate from references**. The portrait's
  background is removed automatically (the `image-prep` container) so the renderer
  gets a clean subject.
- **Training references** -- **generate 10 training images** from the bible (or your
  own uploads). These are the LoRA training set.
- **LoRA training** -- **train LoRA** (roughly 8-15 min on the GPU). The trained LoRA
  is what locks the character's identity into every keyframe.

Use **multi-character scene preview** to sanity-check two or more characters together
before committing them to a film.

## 2. Plan the storyboard (Plan step)

Give the planner a brief and a cast, and an LLM writes the film into scenes (per-shot
prompt, character slots, a shared style prefix, an act arc).

- Pick a **chat model** for the planner (any of the catalog models).
- Either **write a brief** directly ("describe the film: setting, mood, length, key
  beats, who should appear and when"), or use **script my plan** to develop the idea
  conversationally first, then turn the conversation into a brief.
- Select which cast members are in play (the cast chips).
- Click **plan**. The output is a validated `storyboard.yaml` (you can inspect both
  the JSON and the bundle-ready YAML). Validation errors, if any, come with a
  **re-prompt with these errors** button that feeds them back to the model.

Refine without re-planning from scratch:

- **Refine via chat** -- describe a change ("make shot 3 a close-up", "darker tone in
  the second act") and the planner edits the storyboard.
- **Scene editor** -- edit scenes directly, and **export markers** (NLE marker file,
  one per scene) if you are cutting in a real editor later.

Save the storyboard to a named **project** so renders and animations group under it.

## 3. Beat-sync the audio (Audio step) -- before you bundle

This is the step most worth getting right, and the **one place order matters**: the
beat timings are written onto the storyboard's scenes, and the bundle is a snapshot
of the storyboard, so **beat-sync and "apply to storyboard" BEFORE you assemble the
bundle** in step 4. If you bundle first, the bundle has no per-scene durations and
your cuts will not be beat-locked (clips play at their native length instead).

Get a track:

- **Generate** one with the built-in music generator (describe it: "cinematic
  orchestral, slow build, strings + piano, melancholic"), or **suggest from video**
  to derive a prompt from the film, or upload your own file.

Then time the cuts to it:

- **analyze beats (auto)** runs librosa on the track (BPM + downbeats) and proposes a
  per-scene duration plan; review the summary and **apply to storyboard**. This stamps
  `target_seconds` on every scene.
- Or set timing manually: enter **BPM** + **beats per shot** and **snap all scene
  durations** to the grid.

Keep the same track for the final score in step 7 so the beat-locked cuts land on the
music you actually hear.

## 4. Assemble the bundle (Cast & Bundle step)

- **Run preflight** to catch missing pieces (untrained LoRAs, empty prompts, etc.).
- Optionally attach **per-scene start keyframes** -- pin an exact image as a scene's
  first frame (the per-scene keyframe picker). Useful when you have authored art you
  want a shot to begin from.
- Click **bundle**. This packs the storyboard + cleaned cast portraits + references
  into a `.tar.gz` staged in R2. That bundle is what the GPU renders.

## 5. Render (Render step)

Pick a **quality tier**:

- **draft** (33 frames, 8 steps) -- fastest, lowest quality.
- **standard** (33 frames, 12 steps).
- **final** (97 frames, 22 steps) -- production quality; can take 30+ minutes.

Decide full vs preview with the **"render keyframes only (preview before generating
motion)"** checkbox:

- **Recommended: preview first.** Check the box to render just the SDXL **keyframes**
  (the still that opens each shot), no motion. It is fast and cheap, and it is the
  input to the flexible animation step below. Eyeball the stills, lock or regenerate
  any you do not like, then animate.
- Leave it unchecked for a **full** render (keyframes + Wan image-to-video + on-GPU
  assembly) in one pass.

Other knobs (style model -- anime vs photoreal, seed, consistency preset, character
compositing, etc.) sit in the common row and "advanced settings"; each empty control
just means "use the bundle default." Click **render**. A progress bar with an ETA
tracks the job; when it finishes you can **download silent MP4** (full render) or move
to History to animate a preview.

## 6. Put the preview in motion (History step)

Expand a **completed keyframes-only preview** in History. Each shot shows its keyframe
thumbnail and a per-shot control strip (download / regen / lock). Lock the shots you
want; then choose how to animate with the **Motion** selector:

- **GPU Wan** -- finalize the keyframes on the GPU (identity-locked Wan 2.2 i2v). The
  highest-fidelity, identity-stable option; ~20-30 min on the pod.
- **Cloud i2v** -- animate each keyframe through a cloud image-to-video model
  (Seedance / Hailuo / Gen-4.5 / HappyHorse), one call per shot, no GPU spin-up.
  Faster and cheaper; each shot can use a **different** model from the per-shot picker.
- **Hybrid (per-shot GPU/Cloud)** -- the per-shot picker gains a **GPU (Wan)** option
  beside the cloud models, so you route each shot independently: dialogue two-shots to
  Wan, wide atmosphere shots to a cheaper cloud model, assembled into one cut. The
  confirm dialog shows the GPU/cloud split and a cost hint.

All three produce a **silent** MP4. While a hybrid runs, the History row shows
per-lane progress (e.g. `GPU rendering 1/2 . cloud 3/3`); if a shot fails it is
skipped and the run still completes, badged `partial`. Completed rows badge their
version (`GPU . Wan`, `cloud . <model>`, `cloud . mixed`, or `hybrid`) and link back
to the keyframes preview they came from.

See [`i2v-backend-selector.md`](./i2v-backend-selector.md) and
[`i2v-hybrid-backend.md`](./i2v-hybrid-backend.md) for the design, and
[`hybrid-verification-checklist.md`](./hybrid-verification-checklist.md) to validate
the GPU+cloud path end to end.

## 7. Score it (History: add audio / narrate)

The render is silent by design, so the final step lays sound on top without touching
the GPU:

- **add audio** -- mux a music bed (uploaded or generated) onto the finished picture.
  Use the **same** track you beat-synced in step 3 so the cuts land on its beats.
- **narrate** -- synthesize spoken narration from text (Workers AI TTS) and mux it on.

Both run through the `video-finish` container and stream-copy the video (no rescale),
so the resolution is preserved. The result is a new downloadable MP4 with audio.

---

## Tips and gotchas

- **Beat-sync before you bundle** (step 3). It is the easiest thing to get backwards,
  and it silently costs you beat-locked cuts.
- **Preview first to save GPU minutes.** A keyframes-only preview lets you fix stills
  cheaply and then pick the cheapest motion backend that meets the bar, per shot.
- **Anime vs photoreal and cloud moderation.** Cloud i2v providers can refuse
  photoreal real-person keyframes (Seedance hard-blocks them; Runway has a loosenable
  threshold). Anime keyframes pass. The GPU (Wan) lane has no such restriction, so
  route sensitive shots to GPU in a hybrid.
- **Lock shots you are happy with** before animating so a re-run does not regenerate
  them; **regen** a single shot's keyframe in place if one is off.
- **Hybrid cost** is GPU per-minute (one scale-to-zero pod render for all GPU shots)
  plus cloud per-second per provider for the cloud shots; the confirm dialog shows the
  split.
- **Partial results are kept.** A hybrid that loses a shot to a provider hiccup still
  delivers the rest, badged `partial (N failed)` with a tooltip naming what dropped.
