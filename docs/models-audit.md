# Model catalog audit (#81), 2026-07-18

Comparison of upstream availability vs `src/models.ts`, per issue #81. All upstream columns were
checked LIVE on 2026-07-18 against:

- Workers AI models: https://developers.cloudflare.com/workers-ai/models/ (and per-model pages)
- AI Gateway Unified Billing: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- AI Gateway supported models: https://developers.cloudflare.com/ai-gateway/supported-models/
- CF AI models directory: https://developers.cloudflare.com/ai/models/ (partner model pages)
- xAI model list: https://docs.x.ai/docs/models

Verdict up front: the catalog was already current. Two deprecated Workers AI entries removed, zero
renames, zero broken IDs, 14 data-only adds against existing dispatchers, and a defer list that
needs new dispatch code. Shipped as v0.165.0.

## Actions taken (v0.165.0)

### Removed (2)

| Catalog id | Reason |
|---|---|
| `@cf/google/gemma-3-12b-it` | Marked Deprecated on the Workers AI model list; `@cf/google/gemma-4-26b-a4b-it` stays as the current Gemma |
| `@hf/nousresearch/hermes-2-pro-mistral-7b` | Marked Beta + Deprecated on the Workers AI model list |

### Added (14, all data-only; no new provider code)

| Modality | New id | Notes |
|---|---|---|
| chat | `anthropic/claude-fable-5` | Claude 5 family; anthropic dispatcher, vision + streaming |
| chat | `anthropic/claude-sonnet-5` | Claude 5 family; anthropic dispatcher, vision + streaming |
| chat | `xai/grok-4.5` | On xAI's own list; CF's supported-models page lags it (as it lags the working `grok-build-0.1`), verify on deploy smoke |
| chat | `google/gemini-3.5-flash` | google dispatcher; text-only caps per the existing Gemini convention |
| chat | `@cf/zai-org/glm-5.2` | Verified id + streaming on the per-model page |
| chat | `@cf/moonshotai/kimi-k2.7-code` | Verified id, vision + streaming, on the per-model page |
| image | `google/nano-banana-2` | Same URL-returning proxied path as nano-banana-pro |
| image | `google/imagen-4` | Same path |
| image | `openai/gpt-image-2` | Same dispatch split as gpt-image-1.5: BYOK direct when `OPENAI_API_KEY` is set, opaque proxy otherwise |
| image | `recraft/recraftv4-1-pro` | Existing recraft proxied path |
| video | `alibaba/hh1.1-t2v` | Generic t2v shape |
| video | `alibaba/hh1.1-i2v` | Verified same `{ image, resolution, duration }` schema as hh1-i2v; rides the existing buildGenParams alibaba case |
| video | `alibaba/wan-2.7-i2v` | Schema verified on the CF model page: `image` (required), resolution 720P/1080P, integer duration; same alibaba case |
| video | `xai/grok-imagine-video-1.5-preview` | CF gateway id keeps `-preview`; xAI's own docs list `grok-imagine-video-1.5`. We route via the gateway, so the CF id wins |

### Kept after explicit verification

- `xai/grok-build-0.1`: absent from CF's supported-models page but live on xAI's own model list
  (dedicated coding model, 256k context). CF's page also omits other ids that work; treated as
  page lag, not removal evidence. Re-check on deploy smoke alongside `grok-4.5`.
- `alibaba/hh1-t2v` / `hh1-i2v`: HappyHorse 1.0 still returns 200 on the CF model pages (kept
  upstream as "older versions"). The 1.1 ids are siblings, not renames.
- `recraft/recraftv4`: still listed; "previous generation" but live.
- `@cf/stabilityai/stable-diffusion-xl-base-1.0`: deliberate keep (long-standing catalog note).

## Deferred (needs new dispatch code or fails curation)

| Upstream | Why deferred |
|---|---|
| `openai/gpt-5.5-pro` | Requires the Responses API dispatch path, not the current chat-completions-shaped proxy call |
| `alibaba/hh1.1-r2v` | Reference-to-video: needs reference-input plumbing the worker does not have |
| `runwayml/aleph-2` | Video-edit / input-video semantics; not a fit for the current t2v/i2v param builders |
| Krea, Pruna image; xAI grok-imagine-image | New image provider dispatchers |
| MiniMax M3, Alibaba Qwen3-max/3.5, Groq chat | New chat provider dispatchers (chat path only wires workers-ai / anthropic / xai / openai / google) |
| `google/gemini-3.1-flash-lite`, `openai/gpt-5.4-nano`, `xai/grok-4.20-0309-non-reasoning` | Curation: low-value tier siblings of models already carried |
| `@cf/deepgram/aura-1` | Older generation; aura-2 already covers TTS |

## Flag review

- `streaming` flags: verified correct for all chat entries (only LLaVA 1.5 is single-shot and
  unflagged); no non-chat entry carries the flag.
- `vision` flags on @cf chat models all match upstream. The empty `capabilities` on the proxied
  OpenAI/Gemini chat entries is deliberate (multimodal-in through the proxy is unverified; see the
  comments in `src/models.ts`); the new Claude 5 / grok-4.5 entries follow their group's existing
  convention instead. Revisit item, not a defect.

## Post-refresh counts

39 chat (38 streaming) + 15 image + 20 video + 3 tts + 4 stt + 1 voice + 1 music = 83 catalog
entries across 7 modalities and 12 routed providers.
