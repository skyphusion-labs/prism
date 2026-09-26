// OpenAI direct (BYOK) image generation for transparent PNG.
//
// Why this exists separately from the proxied image path: the Cloudflare
// Unified Billing proxy for openai/gpt-image-* exposes a strict schema
// { prompt, images, quality, size, style } and 7003-rejects `background` and
// `output_format`. OpenAI's own /v1/images/generations endpoint DOES accept
// both, so a direct BYOK call is the only way to get a real alpha channel.
//
// Per Conrad (2026-08-04): this is the SOLE deployer-key exception. Every
// other provider stays on Unified Billing only. Gated on OPENAI_API_KEY:
// when the secret is unset, runImage falls through to the opaque proxy.
//
// GPT image models ALWAYS return base64 (data[0].b64_json); the `url` response
// format is unsupported for them. `background: "transparent"` with
// `output_format: "png"` yields an RGBA PNG.
import type { Env } from "../env";
import { base64ToBytes } from "../utils";

// The deployer key to use for transparent PNG, or null for the opaque proxy.
// prism#193 (v1.0.5): AUTH_MODE=public ignores OPENAI_API_KEY entirely, the
// same fail-closed rule gateway-credentials.ts applies to GATEWAY_ID /
// CF_AIG_TOKEN, so a stray host secret cannot bill the host for a visitor.
export function resolveOpenAIImageKey(env: Env): string | null {
  if (env.AUTH_MODE === "public") return null;
  return env.OPENAI_API_KEY?.trim() || null;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
}

// modelId is the catalog id, e.g. "openai/gpt-image-1.5"; OpenAI wants the bare
// model string, so we strip the "openai/" routing prefix.
export async function generateOpenAIImage(
  apiKey: string,
  modelId: string,
  prompt: string,
): Promise<GeneratedImage> {
  const model = modelId.replace(/^openai\//, "");

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
    }),
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const e = (await resp.json()) as { error?: { message?: string } };
      detail = e?.error?.message ? `: ${e.error.message}` : "";
    } catch {
      /* non-JSON error body; status alone is enough */
    }
    throw new Error(`OpenAI image API ${resp.status}${detail}`);
  }

  const data = (await resp.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI image API returned no b64_json image data");
  }

  return { bytes: base64ToBytes(b64), mime: "image/png" };
}
