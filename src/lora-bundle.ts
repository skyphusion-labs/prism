// Pure helpers for the v0.57.0 standalone LoRA training path.
//
// The route handler in src/index.ts wraps these with the env-touching
// pieces (assembleBundle, submitTrainLoraJob). Keeping the data-shaping
// here lets vitest cover the bundle-builder logic without importing
// cloudflare:workers (which the node test pool cannot resolve).

import type { StoryboardValidated } from "./storyboard-validate";
import type { CastMember } from "./cast-db";

export interface LoraBundleTrainingImage {
  key: string;
}

export interface LoraBundleCharacterRef {
  name: string;
  prompt: string;
  trainingImages: LoraBundleTrainingImage[];
  portrait?: LoraBundleTrainingImage;
}

export interface LoraBundleArgs {
  storyboard: StoryboardValidated;
  characterRefs: Record<string, LoraBundleCharacterRef>;
}

// Build the (storyboard, characterRefs) tuple that assembleBundle takes
// for a single-slot LoRA training bundle. The synthesized storyboard
// satisfies the validator: one scene with a non-empty prompt that
// references slot A, which is also the only entry in use_characters.
export function buildLoraTrainingBundleArgs(
  cast: CastMember,
  bundleSuffix: string,
): LoraBundleArgs {
  const safeSlug = cast.slug || `cast-${cast.id}`;
  const projectName = `lora-${safeSlug}-${bundleSuffix}`;
  return {
    storyboard: {
      title: projectName,
      projectName,
      full_prompt: "",
      duration_seconds: undefined,
      clip_seconds: undefined,
      style_prefix: "",
      style_category: "None",
      style_preset: "None",
      use_characters: ["A"],
      cast_rules: "",
      scenes: [
        {
          id: "lora_train_shot",
          prompt: "lora training reference shot (not rendered)",
          character_slots: ["A"],
          target_seconds: 1,
        },
      ],
    },
    characterRefs: {
      A: {
        name: cast.name,
        prompt: cast.bible || cast.name,
        trainingImages: cast.ref_keys.map((r) => ({ key: r.key })),
        portrait: cast.portrait_key ? { key: cast.portrait_key } : undefined,
      },
    },
  };
}

// Build the destination R2 key for the trained .safetensors. Per-cast
// prefix lets a future GC pass enumerate by cast id; the timestamp
// version keeps retraining immutable so an in-flight render that
// references the prior key does not break.
export function deriveLoraDestKey(castId: number, timestamp: number): string {
  return `loras/cast-${castId}/${timestamp}.safetensors`;
}
