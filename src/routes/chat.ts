// Generation routes: chat (text, multimodal in, streaming), image, TTS, STT,
// music, and video, plus the shared persistence (persistChat) and the job-poll
// endpoint. handleChat dispatches by model.type; runChat/runChatStream own the
// RAG + web-search + multi-turn prelude (retrieval lives in ./rag). Long jobs
// (video/music) hand off to LongRunWorkflow (./workflow).

import type { Env } from "../env";
import type { ModelType, ModelEntry } from "../models";
import { MODELS } from "../models";
import type { InputAttachment } from "../types";
import type { ProviderStreamEvent } from "../parsers/types";
import { parseDataUrl, base64ToBytes } from "../utils";
import { aiRun, aiLogId, type AiContext } from "../ai-binding";
import { extractOutput, extractUsage, detectProviderFailure, extractProxiedImageUrl } from "../output-extract";
import { callAnthropic, callAnthropicStream } from "../providers/anthropic";
import { callXai, callXaiStream } from "../providers/xai";
import { callWorkersAIStream } from "../providers/workers-ai";
import { callOpenAIStream } from "../providers/openai";
import { callGemini, callGeminiStream } from "../providers/google";
import { buildProxiedImageParams } from "../proxied-image-params";
import {
  json,
  getUserEmail,
  requireAiContext,
  modelNeedsCfAigToken,
  r2Put,
  resolveAttachmentKeys,
  safeParseJson,
} from "./shared";
import type {
  ChatRequest,
  RetrievedChunk,
  RetrievedWebResult,
  RetrievedItem,
  PersistedAttachment,
  PersistedDocumentAttachment,
  OutputArtifact,
} from "./shared";
import {
  retrieveContext,
  RETRIEVE_TOP_K,
  searchWeb,
  formatRetrievalForSystemPrompt,
  formatWebForSystemPrompt,
  looksBinary,
} from "./rag";
import { resolveProjectForChat } from "./projects";
import type { LongRunParams } from "./workflow";

//
// Multimodal model types:
//   - chat: text-generation models. Accepts vision attachments if the model
//     declares 'vision' in capabilities. Audio attachments are transcribed
//     via Whisper before the chat call. Video attachments are 8 client-
//     extracted keyframes plus the original file's audio track (also
//     transcribed). Output: text in chats.output.
//   - image: image-generation models (FLUX-1 schnell, Lucid Origin, Phoenix).
//     Input: user_input as prompt, system_prompt as negative_prompt.
//     Output: PNG written to R2, referenced via chats.output_artifact.
//   - tts: text-to-speech models (Aura-2, MeloTTS).
//     Input: user_input as text.
//     Output: audio written to R2, referenced via chats.output_artifact.
//
// Storage:
//   - All input + output artifacts go to R2.
//   - D1 stores R2 keys plus structured metadata.
//   - On DELETE /api/history/:id, R2 objects are removed too.
//   - Artifact ownership is enforced via customMetadata.user_email on the
//     R2 object plus a check in GET /api/artifact/*.


export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// v0.24.0: cap on inline text-file (document) attachments folded into a chat
// prompt. Large files past this are truncated with a marker so a single
// attachment can't blow the model's context window.
export const MAX_DOC_ATTACHMENT_CHARS = 200_000;

// v0.24.0: shared handling for an inline document (text-file) attachment on a
// chat turn. The contents are folded into the prompt as a fenced block, the
// same mechanism as audio transcription. Binary input is rejected via the
// same looksBinary heuristic the RAG uploader uses. Returns either an error
// string for the 400 path or the prompt block + persisted metadata record.
export function buildDocumentAttachment(att: { text?: string; mime?: string; filename?: string }):
  | { error: string }
  | { extra: string; persisted: PersistedDocumentAttachment } {
  const raw = att.text ?? "";
  if (looksBinary(raw)) {
    return { error: `${att.filename || "Attached file"} looks like binary data that can't be read as text. Attach a text-based file (txt, md, yaml, json, csv, source code, etc.).` };
  }
  const truncated = raw.length > MAX_DOC_ATTACHMENT_CHARS;
  const text = truncated ? raw.slice(0, MAX_DOC_ATTACHMENT_CHARS) : raw;
  const fn = att.filename ? ` ${att.filename}` : "";
  const extra = `[Attached file${fn}]\n\`\`\`\n${text}\n\`\`\`${truncated ? "\n[file truncated to fit context]" : ""}`;
  return { extra, persisted: { type: "document", mime: att.mime, filename: att.filename, chars: text.length } };
}

// ---------- /api/chat ----------

export async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ChatRequest;
  try {
    body = await request.json<ChatRequest>();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.model || !body.user_input) {
    return json({ error: "model and user_input are required" }, { status: 400 });
  }
  const model = MODELS.find((x) => x.id === body.model);
  if (!model) {
    return json({ error: `Unknown model: ${body.model}` }, { status: 400 });
  }

  // Hydrate attachment-by-reference (image/video attachments carrying an R2
  // key instead of inline data) before routing, so every handler sees ready
  // attachments. v0.21.7: cross-model artifact reuse within a conversation.
  if (body.attachments?.length) {
    body.attachments = await resolveAttachmentKeys(env, body.attachments, await getUserEmail(request, env));
  }

  if (model.type === "chat") return runChat(request, env, model, body);
  if (model.type === "image") return runImage(request, env, model, body);
  if (model.type === "tts") return runTts(request, env, model, body);
  if (model.type === "video") return runVideo(request, env, ctx, model, body);
  if (model.type === "stt") return runStt(request, env, model, body);
  if (model.type === "music") return runMusic(request, env, ctx, model, body);
  // "voice" is a live streaming session, not a request/response turn. The UI
  // opens the mic streamer (WS /api/stt/stream) instead of POSTing here; reject
  // with a clear pointer in case a client tries the chat path anyway.
  if (model.type === "voice") {
    return json(
      { error: "This is a live voice model; connect to the WebSocket at /api/stt/stream (mic streaming), not /api/chat." },
      { status: 400 },
    );
  }
  return json({ error: `Unsupported model type: ${model.type}` }, { status: 500 });
}

// ---------- /api/chat/stream (v0.13.0) ----------
//
// Thin entry point. Validates input + model, gates by model.streaming +
// model.provider (Pass 1 supports Anthropic only), then dispatches to
// runChatStream. Non-chat types and non-streaming chat models bounce with
// 400 here so the streaming runtime stays narrow.

export async function handleChatStream(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  void ctx; // the response body is a live stream; the worker stays alive while it's open.

  let body: ChatRequest;
  try {
    body = await request.json<ChatRequest>();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.model || !body.user_input) {
    return json({ error: "model and user_input are required" }, { status: 400 });
  }
  const model = MODELS.find((x) => x.id === body.model);
  if (!model) {
    return json({ error: `Unknown model: ${body.model}` }, { status: 400 });
  }
  if (model.type !== "chat") {
    return json({ error: `Streaming is only supported for chat models. Use /api/chat for ${model.type} models.` }, { status: 400 });
  }
  if (!model.streaming) {
    return json({ error: `Model ${model.id} does not support streaming. Use /api/chat (non-streaming) or pick a streaming-capable model.` }, { status: 400 });
  }
  // Anthropic + Workers AI + xAI + OpenAI + Google. Workers AI catalog
  // entries omit `provider` (the type allows this and the ModelEntry default
  // per the type comment is "workers-ai"); Unified Billing providers set it
  // explicitly.
  const isWorkersAI = !model.provider;
  if (
    model.provider !== "anthropic" &&
    model.provider !== "xai" &&
    model.provider !== "openai" &&
    model.provider !== "google" &&
    !isWorkersAI
  ) {
    return json({ error: `Streaming for provider '${model.provider}' is not yet implemented.` }, { status: 501 });
  }

  return runChatStream(request, env, model, body);
}

// ---------- Chat (text generation, multimodal in) ----------

export async function runChat(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;
  const inputs: InputAttachment[] = body.attachments ?? [];

  // v0.20.0: resolve project_id to row, apply per-project system_prompt
  // fallback when the per-turn prompt is empty/undefined. The effective
  // prompt is mutated back onto `body` so downstream provider calls and
  // persistence see exactly what was used. scopedProjectId is passed to
  // retrieveContext so RAG retrieval is filtered to that project's docs.
  const { resolvedSystemPrompt, scopedProjectId } = await resolveProjectForChat(env, userEmail, body);
  body.system_prompt = resolvedSystemPrompt;

  // Hot-path parallelization (v0.12.1): kick off the prior-turns SELECT and
  // the RAG retrieve in the background while the attachment walk runs. None
  // of the three depend on each other (the SELECT only needs the inbound
  // conversation_id + user_email; retrieveContext only needs user_email +
  // the raw user_input), so serializing them costs ~600-1500ms on
  // multimodal+RAG turns. We await each promise at its existing use site
  // below so the error surface is unchanged.
  const conversationIdIn = body.conversation_id?.trim() || "";
  const priorTurnsPromise: Promise<{
    rows: Array<{ user_input: string; output: string; turn_index: number }>;
  }> = conversationIdIn
    ? env.DB.prepare(
        `SELECT user_input, output, turn_index
           FROM chats
          WHERE conversation_id = ?
            AND user_email = ?
            AND status = 'done'
            AND model_type = 'chat'
          ORDER BY turn_index ASC`
      )
        .bind(conversationIdIn, userEmail)
        .all<{ user_input: string; output: string; turn_index: number }>()
        .then((r) => ({ rows: r.results ?? [] }))
    : Promise.resolve({ rows: [] });

  const retrievePromise: Promise<{ chunks: RetrievedChunk[]; error: string | null }> =
    body.use_docs
      ? retrieveContext(env, userEmail, body.user_input, RETRIEVE_TOP_K, scopedProjectId)
      : Promise.resolve({ chunks: [], error: null });

  // v0.17.0: web search runs in parallel with RAG retrieval and the
  // attachment walk. Per-source timeouts + catches inside searchWeb bound
  // the worst-case latency to WEB_SEARCH_TIMEOUT_MS.
  const webSearchPromise: Promise<{ results: RetrievedWebResult[]; error: string | null }> =
    body.use_web_search
      ? searchWeb(env, body.user_input)
      : Promise.resolve({ results: [], error: null });

  // Walk inputs: write images / video frames to R2, transcribe audio via
  // Whisper. Build three parallel structures used after the loop:
  //   - extraText: prompt snippets the LLM sees
  //   - imageDataUrls: data URLs the LLM sees as image_url blocks
  //   - persistedAtt: per-attachment storage records
  const extraText: string[] = [];
  const imageDataUrls: string[] = [];
  const persistedAtt: PersistedAttachment[] = [];

  for (const att of inputs) {
    if (att.type === "image") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision. Pick a vision-capable chat model or remove the image.` }, { status: 400 });
      }
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid image data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      imageDataUrls.push(att.data!); // guaranteed by the parsed guard above (data may be hydrated from a key)
      persistedAtt.push({ type: "image", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "audio") {
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });
      try {
        const wr = await aiRun(aiCtx, WHISPER_MODEL, { audio: parsed.base64 });
        const text = (wr as { text?: string })?.text?.trim() ?? "";
        const label = att.filename ? ` from ${att.filename}` : "";
        extraText.push(text
          ? `[Transcribed audio${label}]\n${text}`
          : `[Audio attachment${label} transcribed to empty text]`);
        persistedAtt.push({ type: "audio", mime: parsed.mime, filename: att.filename, transcript: text || null });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return json({ error: `Audio transcription failed: ${m}` }, { status: 502 });
      }
    } else if (att.type === "video_frames") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision. Video frames require a vision-capable chat model.` }, { status: 400 });
      }
      const frames = att.frames ?? [];
      // Parse first (cheap, synchronous), then fan out R2 puts in parallel.
      // Frames are independent: there's no ordering constraint between R2
      // writes, only between the resulting `imageDataUrls` entries (which
      // we preserve by iterating the same parsedFrames array twice).
      const parsedFrames = frames
        .map((fdataUrl) => ({ fdataUrl, parsed: parseDataUrl(fdataUrl) }))
        .filter((p): p is { fdataUrl: string; parsed: { mime: string; base64: string } } => p.parsed !== null);
      const keys = await Promise.all(
        parsedFrames.map(({ parsed }) =>
          r2Put(env, "in", parsed.mime, base64ToBytes(parsed.base64), userEmail)
        )
      );
      for (const { fdataUrl } of parsedFrames) {
        imageDataUrls.push(fdataUrl);
      }
      const dur = att.duration ? ` ${att.duration.toFixed(1)}s` : "";
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Video${fn}${dur}, ${frames.length} evenly-sampled frames attached below]`);
      persistedAtt.push({ type: "video_frames", keys, frame_count: keys.length, duration: att.duration, filename: att.filename });
    } else if (att.type === "video_full") {
      // Full video file upload. No chat model currently consumes the raw video
      // (the keyframe path covers vision models); the upload is still stored in
      // R2 so it appears in history and the plumbing stays ready for a future
      // video-aware model. Dormant since Bedrock Pegasus was removed in v0.95.0.
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid video data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Full video${fn} attached for video-aware model]`);
      persistedAtt.push({ type: "video_full", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "document") {
      const r = buildDocumentAttachment(att);
      if ("error" in r) return json({ error: r.error }, { status: 400 });
      extraText.push(r.extra);
      persistedAtt.push(r.persisted);
    }
  }

  const userText = [body.user_input, ...extraText].filter(Boolean).join("\n\n");
  const userContent: unknown = imageDataUrls.length
    ? [{ type: "text", text: userText }, ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
    : userText;

  // ---- Multi-turn conversation continuation (v0.10.0) ----
  // If body.conversation_id is present, fetch prior turns of that conversation
  // (filtered to this user, completed chat turns only) and assemble a history
  // of user/assistant message pairs. The current turn appends to that history.
  // If no conversation_id, generate a new one for the first turn.
  // The SELECT itself runs in parallel with the attachment walk (hoisted
  // above as priorTurnsPromise); here we just consume the result.
  let conversationId = conversationIdIn;
  let turnIndex = 0;
  const priorTurns: Array<{ user_input: string; output: string }> = [];

  if (conversationId) {
    const { rows } = await priorTurnsPromise;
    for (const r of rows) {
      // Skip empty/failed prior turns defensively.
      if (r.user_input && r.output) {
        priorTurns.push({ user_input: r.user_input, output: r.output });
      }
    }
    turnIndex = rows.length ? (rows[rows.length - 1].turn_index + 1) : 0;
  } else {
    // crypto.randomUUID() is available in Workers runtime.
    conversationId = crypto.randomUUID();
  }

  // RAG retrieval (Pass 2) - per-turn, applies only to THIS turn's system prompt.
  // The retrieve itself runs in parallel with the attachment walk + prior-turns
  // fetch (hoisted above as retrievePromise); here we just consume the result.
  const { chunks: retrievedChunks, error: retrievalError } = await retrievePromise;

  // v0.17.0: web-search retrieval, same parallelism pattern as RAG.
  const { results: webResults, error: webSearchError } = await webSearchPromise;
  const allRetrieved: RetrievedItem[] = [...retrievedChunks, ...webResults];

  // Build the effective system prompt: user-supplied prompt followed by
  // the retrieval block(s). Order: user prompt, then RAG (more specific
  // to this user's corpus), then web (more general). Either or both
  // retrieval blocks may be empty.
  const userSystemPrompt = body.system_prompt?.trim() ?? "";
  const retrievalBlock = retrievedChunks.length ? formatRetrievalForSystemPrompt(retrievedChunks) : "";
  const webBlock = webResults.length ? formatWebForSystemPrompt(webResults) : "";
  const effectiveSystemPrompt = [userSystemPrompt, retrievalBlock, webBlock]
    .filter(Boolean)
    .join("\n\n");

  // Build the message array. For Anthropic, system goes as a top-level field
  // on the upstream request (handled inside callAnthropic), not in messages.
  // For Workers AI, xAI, and OpenAI, we push a role:"system" message.
  //
  // Prior turns of this conversation go in as alternating user/assistant
  // text messages. Multimodal content (images) from prior turns is NOT
  // re-included; if the user wants to reference earlier images they can
  // re-attach. Current turn's attachments are still threaded into userContent.
  const wantsSystemInMessages = model.provider !== "anthropic" && model.provider !== "google";
  const messages: Array<unknown> = [];
  if (effectiveSystemPrompt && wantsSystemInMessages) {
    messages.push({ role: "system", content: effectiveSystemPrompt });
  }
  for (const t of priorTurns) {
    messages.push({ role: "user", content: t.user_input });
    messages.push({ role: "assistant", content: t.output });
  }
  messages.push({ role: "user", content: userContent });

  const start = Date.now();
  let result: unknown;
  let logId: string | null = null;
  try {
    if (model.id === "@cf/llava-hf/llava-1.5-7b-hf") {
      // LLaVA 1.5 is image-to-text: input is { image: number[] (raw bytes),
      // prompt, max_tokens }, not the chat { messages } shape, and it's
      // single-shot (one image + one prompt; prior turns and system prompt are
      // not threaded). We surface it as a vision chat model so the existing
      // attach UI works, but route it here for the different wire format.
      const imgAtt = inputs.find((a) => a.type === "image");
      if (!imgAtt?.data) {
        return json({ error: "LLaVA needs an image attachment. Attach one, then ask about it." }, { status: 400 });
      }
      const parsedImg = parseDataUrl(imgAtt.data);
      if (!parsedImg) {
        return json({ error: "Invalid image data URL" }, { status: 400 });
      }
      result = await aiRun(aiCtx, model.id, {
        image: [...base64ToBytes(parsedImg.base64)],
        prompt: body.user_input || "Describe this image in detail.",
        max_tokens: 512,
      });
      logId = aiLogId(aiCtx);
    } else if (model.provider === "anthropic") {
      const r = await callAnthropic(aiCtx, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "xai") {
      const r = await callXai(aiCtx, model, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "google") {
      const r = await callGemini(aiCtx, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      result = await aiRun(aiCtx, model.id, { messages });
      logId = aiLogId(aiCtx);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `AI call failed: ${m}` }, { status: 502 });
  }

  // Some providers (notably OpenAI/Gemini proxied via unified billing) return
  // a failure envelope { state: "Failed", error: "..." } as a resolved value
  // instead of throwing. Surface it as a 502 here; otherwise extractOutput
  // would stringify the envelope into chats.output and persist the failed
  // turn as a success.
  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return json({ error: `Model execution failed: ${providerFailure}` }, { status: 502 });
  }

  const latency = Date.now() - start;
  const output = extractOutput(result);
  const usage = extractUsage(result);

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "chat",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output,
    output_artifact: null,
    attachments: persistedAtt,
    tokens_in: usage.in_,
    tokens_out: usage.out_,
    latency_ms: latency,
    ai_gateway_log_id: logId,
    retrieved_context: allRetrieved.length ? allRetrieved : null,
    conversation_id: conversationId,
    turn_index: turnIndex,
    project_id: scopedProjectId ?? null,
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "chat",
    output,
    tokens_in: usage.in_,
    tokens_out: usage.out_,
    latency_ms: latency,
    ai_gateway_log_id: logId,
    transcripts: extraText,
    retrieved_chunks: retrievedChunks,
    web_results: webResults,
    conversation_id: conversationId,
    turn_index: turnIndex,
    // Diagnostic: when either retrieval source was on, include the exact text
    // that went into the model as the system prompt, plus per-source errors.
    // Inspect via browser DevTools to verify the retrieval block reached
    // the model.
    effective_system_prompt: (body.use_docs || body.use_web_search) ? effectiveSystemPrompt : undefined,
    retrieval_error: body.use_docs ? retrievalError : undefined,
    web_search_error: body.use_web_search ? webSearchError : undefined,
  });
}

// ---------- Image generation ----------

export async function runImage(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  let aiCtx: AiContext | null = null;
  const needsProxiedGateway = !!model.provider;
  if (needsProxiedGateway) {
    const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: true });
    if (ctxOrErr instanceof Response) return ctxOrErr;
    aiCtx = ctxOrErr;
  }

  // Image gen splits two ways. Proxied models (those with a `provider`:
  // nano-banana/google, gpt-image-1.5/openai, recraftv4/recraft) go through the
  // gateway binding, return a URL, and share one code path. The @cf models
  // (no `provider`) return base64 or a ReadableStream and need the bypass +
  // shape-detection handling below. Both converge on the (bytes, mime) tuple
  // and the shared R2-put + persist + respond tail.
  let bytes: Uint8Array;
  let mime: string;
  let latency: number;
  let logId: string | null = null;

  const start = Date.now();
  try {
    if (model.provider) {
      // Proxied image (Unified Billing via the gateway): nano-banana (google),
      // recraftv4 (recraft), and gpt-image-1.5 / gpt-image-2 (openai). All are
      // opaque; v0.166.0 retired the OPENAI_API_KEY BYOK transparent-PNG path
      // (prism#93), so gpt-image-* now ride the proxy like the others.
      // The @cf models carry no `provider`, so this branch is exactly the
      // proxied set. Per-provider request shape comes from buildProxiedImageParams
      // because each upstream schema is additionalProperties:false and rejects
      // the @cf { width, height, steps, negative_prompt } shape; system_prompt
      // has no negative_prompt slot on any of them and is ignored.
      //
      // They return a URL (not base64) in the { state, result } envelope:
      //   { state: "Completed", result: { image: "<url>" } }
      // so we fetch the URL and store the bytes, like the video path does. mime
      // comes from the response content-type (recraftv4 returns webp, the
      // openai/google paths return png), so no format is hardcoded on the store.
      // (First pass is text-to-image only; gpt-image-1.5's images[] editing and
      // reference inputs are a later add, mirroring the FLUX.2 ref-image work.)
      const result = await aiRun(aiCtx!, model.id, buildProxiedImageParams(model.provider, body.user_input));
      logId = aiLogId(aiCtx!);

      const failure = detectProviderFailure(result);
      if (failure) {
        return json({ error: `Image generation failed: ${failure}` }, { status: 502 });
      }
      const imageUrl = extractProxiedImageUrl(result);
      if (!imageUrl) {
        return json({ error: "Image generation returned no image URL", raw: result }, { status: 502 });
      }
      const aresp = await fetch(imageUrl);
      if (!aresp.ok) {
        return json({ error: `Failed to fetch generated image: ${aresp.status}` }, { status: 502 });
      }
      bytes = new Uint8Array(await aresp.arrayBuffer());
      mime = aresp.headers.get("content-type") || "image/png";
    } else {
    // Two Cloudflare-side complications for Workers AI image gen as of
    // 2026-Q1, both manifesting as either:
      //   - AiError 5006 "required properties at '/' are 'multipart'", or
      //   - "AI Gateway does not support ReadableStreams yet"
      //
      // The matrix:
      //   FLUX-1 schnell, Lucid Origin   - JSON in,    JSON out (base64).   Gateway path works.
      //   FLUX-2 (Klein 9b/4b, Dev)      - multipart in, JSON out (base64). Gateway can't proxy stream input.
      //   Phoenix 1.0, Dreamshaper 8 LCM - JSON in,    ReadableStream out.  Gateway can't proxy stream output.
      //
      // Solution: bypass the AI Gateway for the five problematic models by
      // calling env.AI.run directly without the gateway option, and detect
      // the response shape at runtime so we can drain a ReadableStream into
      // bytes or extract base64 from JSON as appropriate. Cost: no AI Gateway
      // observability/caching for these specific models (ai_gateway_log_id
      // stays null on the persisted row).
      const isFlux2 = model.id.startsWith("@cf/black-forest-labs/flux-2-");
      const isSdxl = model.id === "@cf/stabilityai/stable-diffusion-xl-base-1.0";
      const bypassGateway = isFlux2
        || model.id === "@cf/leonardo/phoenix-1.0"
        || model.id === "@cf/lykon/dreamshaper-8-lcm"
        || isSdxl; // SDXL returns a ReadableStream image; gateway can't proxy it

      let runParams: unknown;

      if (isFlux2) {
        // FLUX.2 requires multipart form data input. FormData doesn't expose
        // its serialized body or boundary directly; wrap in a Response
        // constructor to get the stream + the Content-Type header value
        // with the boundary string.
        const form = new FormData();
        form.append("prompt", body.user_input);
        form.append("width", "1024");
        form.append("height", "1024");
        if (body.system_prompt && body.system_prompt.trim()) {
          // FLUX.2's public schema doesn't list negative_prompt, but the
          // binding ignores unknown form fields rather than erroring.
          form.append("negative_prompt", body.system_prompt);
        }

        // Reference images (v0.16.0): FLUX.2 accepts up to 4 input images
        // via input_image_0..input_image_3 form fields. Each must be at most
        // 512x512 (the frontend downscales before upload). We silently cap
        // beyond 4 rather than erroring, so a user who picks 5 just doesn't
        // see the 5th show up; the picker UI also caps at 4 client-side.
        const inputs: InputAttachment[] = body.attachments ?? [];
        let refIdx = 0;
        for (const att of inputs) {
          if (refIdx >= 4) break;
          if (att.type !== "image" || !att.data) continue;
          const parsed = parseDataUrl(att.data);
          if (!parsed) continue;
          const blob = new Blob([base64ToBytes(parsed.base64)], { type: parsed.mime });
          form.append(`input_image_${refIdx}`, blob, att.filename || `ref-${refIdx}.png`);
          refIdx++;
        }

        const formResponse = new Response(form);
        runParams = {
          multipart: {
            body: formResponse.body!,
            contentType: formResponse.headers.get("content-type")!,
          },
        };
      } else {
        const params: Record<string, unknown> = {
          prompt: body.user_input,
          width: 1024,
          height: 1024,
          steps: 25,
        };
        if (body.system_prompt && body.system_prompt.trim()) {
          params.negative_prompt = body.system_prompt;
        }
        // FLUX-1 schnell uses fewer steps and has no negative_prompt.
        if (model.id === "@cf/black-forest-labs/flux-1-schnell") {
          params.steps = 4;
          delete params.negative_prompt;
        }
        // SDXL's step field is `num_steps` (max 20), not `steps`; swap to avoid
        // sending an unknown/over-max field.
        if (isSdxl) {
          delete params.steps;
          params.num_steps = 20;
        }
        runParams = params;
      }

      // Run via the binding. Bypass the gateway for stream-incompatible
      // models; everything else stays on the aiRun helper path (which
      // populates ai_gateway_log_id for observability).
      let result: unknown;
      if (bypassGateway) {
        type BypassRunFn = (model: string, params: unknown) => Promise<unknown>;
        result = await (env.AI as unknown as { run: BypassRunFn }).run(model.id, runParams);
      } else {
        if (!aiCtx) {
          const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
          if (ctxOrErr instanceof Response) return ctxOrErr;
          aiCtx = ctxOrErr;
        }
        result = await aiRun(aiCtx, model.id, runParams);
        logId = aiLogId(aiCtx);
      }

      // Two response shapes are possible:
      //   1. JSON { image: "base64..." } - FLUX-1, FLUX-2, Lucid Origin
      //   2. ReadableStream of raw PNG bytes - Phoenix, Dreamshaper
      // Detect at runtime rather than mapping per-model; safer if Cloudflare
      // shifts a model from one shape to the other.
      if (result instanceof ReadableStream) {
        const reader = result.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.length;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.length;
        }
        // All stream-output image models here emit PNG bytes. (The SDXL docs
        // claim image/jpg, but the binding's actual output is PNG, confirmed
        // live, so we don't special-case it.)
        mime = "image/png";
      } else {
        const b64 = (result as { image?: string })?.image;
        if (!b64 || typeof b64 !== "string") {
          return json({ error: "Image generation returned no image", raw: result }, { status: 502 });
        }
        bytes = base64ToBytes(b64);
        // FLUX.2 outputs PNG; the older JSON path returned JPEG historically.
        mime = isFlux2 ? "image/png" : "image/jpeg";
      }
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Image generation failed: ${m}` }, { status: 502 });
  }
  latency = Date.now() - start;

  const key = await r2Put(env, "out", mime, bytes, userEmail);
  const outputArtifact: OutputArtifact = { key, mime, type: "image" };

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "image",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output: "",
    output_artifact: outputArtifact,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: latency,
    ai_gateway_log_id: logId,
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "image",
    output: "",
    output_artifact: outputArtifact,
    latency_ms: latency,
    ai_gateway_log_id: logId,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- TTS ----------

// v0.118.0: speak arbitrary text via Aura-2 and stream the audio back. No D1
// row (the voice-chat loop calls this for every assistant reply; persisting
// each one would flood history). Caps length and restricts the voice to the
// two Aura-2 catalog entries.
export const TTS_VOICES = new Set(["@cf/deepgram/aura-2-en", "@cf/deepgram/aura-2-es"]);
export async function handleTtsSpeak(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;

  let body: { text?: string; voice?: string };
  try {
    body = await request.json<{ text?: string; voice?: string }>();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!text) return json({ error: "text required" }, { status: 400 });
  const voice = body.voice && TTS_VOICES.has(body.voice) ? body.voice : "@cf/deepgram/aura-2-en";
  try {
    const resp = await aiRun(aiCtx, voice, { text, prompt: text }, true /* returnRawResponse */);
    if (!(resp instanceof Response)) {
      return json({ error: "TTS returned non-Response shape" }, { status: 502 });
    }
    const mime = resp.headers.get("content-type") || "audio/mpeg";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return new Response(bytes, { headers: { "content-type": mime, "cache-control": "no-store" } });
  } catch (err) {
    return json({ error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}

export async function runTts(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;

  let mime: string;
  let bytes: Uint8Array;
  let logId: string | null = null;

  const start = Date.now();
  try {
    // Aura: { text }; MeloTTS: { prompt, lang? }. Send both keys defensively.
    const params: Record<string, unknown> = { text: body.user_input, prompt: body.user_input };
    const resp = await aiRun(aiCtx, model.id, params, true /* returnRawResponse */);
    logId = aiLogId(aiCtx);
    if (!(resp instanceof Response)) {
      return json({ error: "TTS returned non-Response shape", raw: resp }, { status: 502 });
    }
    mime = resp.headers.get("content-type") || "audio/mpeg";
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `TTS failed: ${m}` }, { status: 502 });
  }
  const latency = Date.now() - start;

  const key = await r2Put(env, "out", mime, bytes, userEmail);
  const outputArtifact: OutputArtifact = { key, mime, type: "audio" };

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "tts",
    system_prompt: null,
    user_input: body.user_input,
    output: "",
    output_artifact: outputArtifact,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: latency,
    ai_gateway_log_id: logId,
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "tts",
    output: "",
    output_artifact: outputArtifact,
    latency_ms: latency,
    ai_gateway_log_id: logId,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- Speech-to-text (Whisper) ----------
//
// Synchronous: user attaches an audio file and picks a Whisper model, worker
// calls Whisper directly and returns the transcript as the row's `output`
// text. No D1 status='pending' or polling - Whisper completes in seconds.
// Reuses the existing audio attachment shape from the chat path.

// Deepgram ASR on Workers AI returns the native Deepgram results object, not
// the top-level { text } that Whisper returns. Standard path is
// results.channels[0].alternatives[0].transcript; we also tolerate a couple of
// alternate shapes and a normalized top-level text/transcript, defensively.
export function extractDeepgramTranscript(result: unknown): string {
  const r = result as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
      alternatives?: Array<{ transcript?: string }>;
    };
    text?: string;
    transcript?: string;
  };
  const viaChannels = r?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof viaChannels === "string") return viaChannels.trim();
  const viaAlternatives = r?.results?.alternatives?.[0]?.transcript;
  if (typeof viaAlternatives === "string") return viaAlternatives.trim();
  if (typeof r?.transcript === "string") return r.transcript.trim();
  if (typeof r?.text === "string") return r.text.trim();
  return "";
}

export async function runStt(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;
  const t0 = Date.now();

  const audioAtt = (body.attachments ?? []).find((a) => a.type === "audio");
  if (!audioAtt?.data) {
    return json({ error: "Please attach an audio file to transcribe" }, { status: 400 });
  }
  const parsed = parseDataUrl(audioAtt.data);
  if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });

  const viaDeepgram = model.id.startsWith("@cf/deepgram/");
  let transcript: string;
  try {
    if (viaDeepgram) {
      // Deepgram wants { audio: { body, contentType } } where body is a
      // ReadableStream of the audio bytes (a bare base64 string or Uint8Array
      // fails schema validation). AI Gateway does not support ReadableStream
      // inputs ("error 5006/ReadableStreams not supported"), so this is the
      // one call that bypasses the gateway and hits the binding directly;
      // there's no cf-aig-log-id for it (logId stays null below). Output is
      // the native Deepgram results object, parsed by extractDeepgramTranscript.
      const dr = await (env.AI as unknown as { run: (m: string, p: unknown) => Promise<unknown> })
        .run(model.id, { audio: { body: new Response(base64ToBytes(parsed.base64)).body, contentType: parsed.mime } });
      transcript = extractDeepgramTranscript(dr);
    } else {
      const wr = await aiRun(aiCtx, model.id, { audio: parsed.base64 });
      transcript = (wr as { text?: string })?.text?.trim() ?? "";
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Transcription failed: ${m}` }, { status: 502 });
  }

  const latency = Date.now() - t0;
  // Persist the audio's transcript on the attachment record but not the
  // raw audio bytes (same convention as the chat path).
  const persistedAtt: PersistedAttachment[] = [{
    type: "audio",
    mime: parsed.mime,
    filename: audioAtt.filename,
    transcript: transcript || null,
  }];

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "stt",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input || "(audio attachment)",
    output: transcript || "(empty transcript)",
    output_artifact: null,
    attachments: persistedAtt,
    tokens_in: null,
    tokens_out: null,
    latency_ms: latency,
    ai_gateway_log_id: viaDeepgram ? null : aiLogId(aiCtx),
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "stt",
    output: transcript,
    output_artifact: null,
    latency_ms: latency,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// Conversational STT (@cf/deepgram/flux) is handled by the SttSession Durable
// Object (src/stt-session.ts), which the /api/stt/stream route forwards the WS
// upgrade to. It bridges to flux and persists the final transcript to /history.

// ---------- Music generation (MiniMax via Unified Billing) ----------
//
// As of v0.12.0, music gen uses Cloudflare Workflows for durable execution.
// The runMusic handler creates a LongRunWorkflow instance, persists its ID
// on the chats row as job_id, and returns immediately. The workflow handles
// the actual env.AI.run call (which blocks for ~30-90 seconds), downloads
// the audio, uploads to R2, and finalizes the D1 row.
//
// User input maps to fields:
//   body.user_input    -> "prompt" (style/mood description, ~10-300 chars)
//   body.system_prompt -> "lyrics" (optional, supports [Verse]/[Chorus] tags)

export async function runMusic(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  // ctx unused now that we no longer schedule a waitUntil task; the workflow
  // owns the long-running work. Kept in signature for router compatibility.
  void ctx;
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  void ctxOrErr; // credentials validated; workflow loads them from D1 by userEmail
  const startedAt = new Date().toISOString();

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "music",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output: "",
    output_artifact: null,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: 0,
    ai_gateway_log_id: null,
    status: "pending",
    job_id: null,
    job_provider: model.provider ?? null,
    job_error: null,
    job_started_at: startedAt,
  });

  // Kick off the workflow. The instance ID is stored on the row so we can
  // look it up later for status/observability. If create() itself fails
  // (e.g., quota exceeded), fail the row synchronously so the client sees
  // an error rather than an indefinite pending state.
  // v0.62.0: MiniMax music-2.6 returns gateway error 7003 ("User Input
  // Error") when lyrics is empty or missing, even for instrumental
  // requests. Default to "[Instrumental]" - the model's own marker
  // syntax - so a caller that wants an instrumental track can omit the
  // system_prompt without their job failing seconds after submit. A
  // non-empty system_prompt (real lyrics) wins.
  const rawLyrics = (body.system_prompt ?? "").trim();
  const lyrics = rawLyrics.length > 0 ? body.system_prompt! : "[Instrumental]";

  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: {
        rowId: row.id,
        userEmail,
        modelId: model.id,
        prompt: body.user_input,
        lyrics,
        kind: "music",
        startedAtIso: startedAt,
      } satisfies LongRunParams,
    });
    instanceId = instance.id;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
      .bind(`Workflow create failed: ${m}`.slice(0, 1000), row.id)
      .run();
    return json({ error: `Failed to start music generation: ${m}` }, { status: 502 });
  }

  // Persist the workflow instance ID on the row for traceability.
  await env.DB.prepare(`UPDATE chats SET job_id = ? WHERE id = ?`)
    .bind(instanceId, row.id)
    .run();

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "music",
    output: "",
    output_artifact: null,
    status: "pending",
    job_started_at: startedAt,
    job_id: instanceId,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- Persistence ----------

export interface PersistArgs {
  userEmail: string;
  model: string;
  model_type: ModelType;
  system_prompt: string | null;
  user_input: string;
  output: string;
  output_artifact: OutputArtifact | null;
  attachments: PersistedAttachment[];
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number;
  ai_gateway_log_id: string | null;
  status?: "pending" | "done" | "failed";
  job_id?: string | null;
  job_provider?: string | null;
  job_error?: string | null;
  job_started_at?: string | null;
  retrieved_context?: RetrievedItem[] | null;
  conversation_id?: string | null;
  turn_index?: number | null;
  project_id?: number | null;  // v0.20.2: project this chat turn was sent within
}

export async function persistChat(env: Env, a: PersistArgs): Promise<{ id: number; created_at: string; conversation_id: string }> {
  // For non-chat model types (image/tts/video/etc), conversation_id is
  // auto-assigned as a synthetic per-row key so the rows still group in the
  // sidebar as single-turn entries.
  const convId = a.conversation_id ?? null;
  const turnIdx = a.turn_index ?? null;

  const row = await env.DB.prepare(
    `INSERT INTO chats
       (user_email, model, model_type, system_prompt, user_input, output,
        output_artifact, attachments,
        tokens_in, tokens_out, latency_ms, ai_gateway_log_id,
        status, job_id, job_provider, job_error, job_started_at,
        retrieved_context, conversation_id, turn_index, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(
      a.userEmail, a.model, a.model_type, a.system_prompt, a.user_input, a.output,
      a.output_artifact ? JSON.stringify(a.output_artifact) : null,
      a.attachments.length ? JSON.stringify(a.attachments) : null,
      a.tokens_in, a.tokens_out, a.latency_ms, a.ai_gateway_log_id,
      a.status ?? "done",
      a.job_id ?? null,
      a.job_provider ?? null,
      a.job_error ?? null,
      a.job_started_at ?? null,
      a.retrieved_context && a.retrieved_context.length ? JSON.stringify(a.retrieved_context) : null,
      convId,
      turnIdx,
      a.project_id ?? null
    )
    .first<{ id: number; created_at: string }>();

  if (!row) {
    return { id: 0, created_at: new Date().toISOString(), conversation_id: "" };
  }

  // For non-chat rows that didn't get an explicit conversation_id, backfill
  // a synthetic one so they appear in the conversation list.
  let finalConvId = convId;
  if (!finalConvId) {
    finalConvId = `single-${row.id}`;
    await env.DB.prepare(
      `UPDATE chats SET conversation_id = ?, turn_index = 0 WHERE id = ?`
    )
      .bind(finalConvId, row.id)
      .run();
  }

  return { id: row.id, created_at: row.created_at, conversation_id: finalConvId };
}

// ---------- runChatStream (v0.13.0) ----------
//
// Streaming counterpart of runChat. Shares the prelude contract (parallel
// hoisting of priorTurnsPromise + retrievePromise overlapping the attachment
// walk; multi-turn continuation; RAG system-prompt assembly) and diverges
// at the model call: each provider's stream adapter (callAnthropicStream
// in src/providers/anthropic.ts, etc.) is an async generator that yields
// normalized text deltas and usage events.
//
// Wire format on the response body (text/event-stream):
//   data: {"type":"delta","text":"..."}
//   data: {"type":"done","row_id":N,"latency_ms":N,"tokens_in":N|null,
//          "tokens_out":N|null,"conversation_id":"...","turn_index":N}
//   data: {"type":"error","message":"..."}
//
// Anthropic's native SSE event types (message_start, content_block_delta,
// content_block_stop, message_delta, message_stop, ping, etc.) are stripped
// inside callAnthropicStream and normalized to the envelope above.
//
// On client disconnect, the next writer.write() throws; we abort the
// upstream Anthropic fetch via AbortController and exit without persisting
// the partial response. Design decision B (Pass 1): drop partials.
//
// NOTE: the prelude here intentionally duplicates the prelude in runChat.
// Both functions own the same shape but persist + respond differently. A
// later pass may extract a shared helper; for Pass 1 the duplication is
// bounded and easier to read than a parameterized abstraction.

export async function runChatStream(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;
  const inputs: InputAttachment[] = body.attachments ?? [];

  // v0.20.0: same project resolution as runChat. See resolveProjectForChat
  // for semantics. Mutating body.system_prompt here means downstream code
  // (provider call, persistence) sees the effective prompt with no further
  // awareness of projects.
  const { resolvedSystemPrompt, scopedProjectId } = await resolveProjectForChat(env, userEmail, body);
  body.system_prompt = resolvedSystemPrompt;

  // Hot-path parallelization (mirrors runChat v0.12.1). Kick off SELECT +
  // RAG retrieve before the attachment walk; await at the existing use sites.
  const conversationIdIn = body.conversation_id?.trim() || "";
  const priorTurnsPromise: Promise<{
    rows: Array<{ user_input: string; output: string; turn_index: number }>;
  }> = conversationIdIn
    ? env.DB.prepare(
        `SELECT user_input, output, turn_index
           FROM chats
          WHERE conversation_id = ?
            AND user_email = ?
            AND status = 'done'
            AND model_type = 'chat'
          ORDER BY turn_index ASC`
      )
        .bind(conversationIdIn, userEmail)
        .all<{ user_input: string; output: string; turn_index: number }>()
        .then((r) => ({ rows: r.results ?? [] }))
    : Promise.resolve({ rows: [] });

  const retrievePromise: Promise<{ chunks: RetrievedChunk[]; error: string | null }> =
    body.use_docs
      ? retrieveContext(env, userEmail, body.user_input, RETRIEVE_TOP_K, scopedProjectId)
      : Promise.resolve({ chunks: [], error: null });

  // v0.17.0: web search runs in parallel with RAG retrieval, same as runChat.
  const webSearchPromise: Promise<{ results: RetrievedWebResult[]; error: string | null }> =
    body.use_web_search
      ? searchWeb(env, body.user_input)
      : Promise.resolve({ results: [], error: null });

  // Attachment walk. Reach completion before any bytes flow back; streaming
  // helps with time-to-last-token, not time-to-first-token on multimodal turns.
  const extraText: string[] = [];
  const imageDataUrls: string[] = [];
  const persistedAtt: PersistedAttachment[] = [];

  for (const att of inputs) {
    if (att.type === "image") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision.` }, { status: 400 });
      }
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid image data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      imageDataUrls.push(att.data!); // guaranteed by the parsed guard above (data may be hydrated from a key)
      persistedAtt.push({ type: "image", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "audio") {
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });
      try {
        const wr = await aiRun(aiCtx, WHISPER_MODEL, { audio: parsed.base64 });
        const text = (wr as { text?: string })?.text?.trim() ?? "";
        const label = att.filename ? ` from ${att.filename}` : "";
        extraText.push(text
          ? `[Transcribed audio${label}]\n${text}`
          : `[Audio attachment${label} transcribed to empty text]`);
        persistedAtt.push({ type: "audio", mime: parsed.mime, filename: att.filename, transcript: text || null });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return json({ error: `Audio transcription failed: ${m}` }, { status: 502 });
      }
    } else if (att.type === "video_frames") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision.` }, { status: 400 });
      }
      const frames = att.frames ?? [];
      const parsedFrames = frames
        .map((fdataUrl) => ({ fdataUrl, parsed: parseDataUrl(fdataUrl) }))
        .filter((p): p is { fdataUrl: string; parsed: { mime: string; base64: string } } => p.parsed !== null);
      const keys = await Promise.all(
        parsedFrames.map(({ parsed }) =>
          r2Put(env, "in", parsed.mime, base64ToBytes(parsed.base64), userEmail)
        )
      );
      for (const { fdataUrl } of parsedFrames) {
        imageDataUrls.push(fdataUrl);
      }
      const dur = att.duration ? ` ${att.duration.toFixed(1)}s` : "";
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Video${fn}${dur}, ${frames.length} evenly-sampled frames attached below]`);
      persistedAtt.push({ type: "video_frames", keys, frame_count: keys.length, duration: att.duration, filename: att.filename });
    } else if (att.type === "video_full") {
      // No streaming model accepts raw video; reject explicitly so the user
      // attaches extracted frames instead of getting silent truncation.
      return json({ error: "Raw video attachments are not accepted on the streaming path. Attach extracted frames instead." }, { status: 400 });
    } else if (att.type === "document") {
      const r = buildDocumentAttachment(att);
      if ("error" in r) return json({ error: r.error }, { status: 400 });
      extraText.push(r.extra);
      persistedAtt.push(r.persisted);
    }
  }

  const userText = [body.user_input, ...extraText].filter(Boolean).join("\n\n");
  const userContent: unknown = imageDataUrls.length
    ? [{ type: "text", text: userText }, ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
    : userText;

  // Consume the parallel-hoisted promises.
  let conversationId = conversationIdIn;
  let turnIndex = 0;
  const priorTurns: Array<{ user_input: string; output: string }> = [];

  if (conversationId) {
    const { rows } = await priorTurnsPromise;
    for (const r of rows) {
      if (r.user_input && r.output) {
        priorTurns.push({ user_input: r.user_input, output: r.output });
      }
    }
    turnIndex = rows.length ? (rows[rows.length - 1].turn_index + 1) : 0;
  } else {
    conversationId = crypto.randomUUID();
  }

  const { chunks: retrievedChunks } = await retrievePromise;
  const { results: webResults } = await webSearchPromise;
  const allRetrieved: RetrievedItem[] = [...retrievedChunks, ...webResults];

  const userSystemPrompt = body.system_prompt?.trim() ?? "";
  const retrievalBlock = retrievedChunks.length ? formatRetrievalForSystemPrompt(retrievedChunks) : "";
  const webBlock = webResults.length ? formatWebForSystemPrompt(webResults) : "";
  const effectiveSystemPrompt = [userSystemPrompt, retrievalBlock, webBlock]
    .filter(Boolean)
    .join("\n\n");

  // Build the message array. For providers that take system as a separate
  // top-level param (Anthropic), we DON'T include a system role here;
  // callAnthropicStream pulls effectiveSystemPrompt to a top-level field.
  // For Workers AI (and any future provider that accepts role:"system" in
  // messages, like xAI's OpenAI-compatible API), we DO push it.
  const wantsSystemInMessages = !(model.provider === "anthropic");
  const messages: Array<unknown> = [];
  if (effectiveSystemPrompt && wantsSystemInMessages) {
    messages.push({ role: "system", content: effectiveSystemPrompt });
  }
  for (const t of priorTurns) {
    messages.push({ role: "user", content: t.user_input });
    messages.push({ role: "assistant", content: t.output });
  }
  messages.push({ role: "user", content: userContent });

  // TransformStream pattern: return `readable` as the response body, write
  // SSE events to `writer`. The worker stays alive while writer is open, so
  // the background IIFE doesn't need ctx.waitUntil.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Emit one SSE event. Returns false if the writer is closed (client
  // disconnected); caller uses this to short-circuit + abort upstream.
  const emit = async (event: Record<string, unknown>): Promise<boolean> => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      return true;
    } catch {
      return false;
    }
  };

  const upstreamAbort = new AbortController();
  const start = Date.now();

  // Background IIFE drives the stream. Does NOT await; this function returns
  // the Response immediately while the IIFE writes events to the body.
  (async () => {
    let accumulated = "";
    let usageIn: number | null = null;
    let usageOut: number | null = null;

    try {
      // Dispatch per provider. All generators yield the same ProviderStreamEvent
      // shape so the consumer loop is provider-agnostic.
      let streamGenerator: AsyncGenerator<ProviderStreamEvent>;
      if (model.provider === "anthropic") {
        streamGenerator = callAnthropicStream(aiCtx, model, effectiveSystemPrompt || undefined, messages, upstreamAbort.signal);
      } else if (model.provider === "xai") {
        streamGenerator = callXaiStream(aiCtx, model, messages, upstreamAbort.signal);
      } else if (model.provider === "openai") {
        streamGenerator = callOpenAIStream(aiCtx, model, messages, upstreamAbort.signal);
      } else if (model.provider === "google") {
        streamGenerator = callGeminiStream(aiCtx, model, effectiveSystemPrompt || undefined, messages, upstreamAbort.signal);
      } else {
        streamGenerator = callWorkersAIStream(aiCtx, model, messages, upstreamAbort.signal);
      }

      for await (const ev of streamGenerator) {
        if (ev.type === "text") {
          accumulated += ev.text;
          const ok = await emit({ type: "delta", text: ev.text });
          if (!ok) {
            // Client gone. Abort upstream so we stop paying for tokens
            // and exit without persisting (Pass 1: drop partials).
            upstreamAbort.abort();
            return;
          }
        } else if (ev.type === "usage") {
          if (ev.in_ !== null) usageIn = ev.in_;
          if (ev.out_ !== null) usageOut = ev.out_;
        }
      }

      const latency = Date.now() - start;

      // Persist as a single row. retrieved_context is saved on the row so
      // the History/Conversation views render citations the same way runChat
      // does. v0.17.0: web-search results are stored in the same column with
      // a source_type discriminator. ai_gateway_log_id is null: streaming
      // responses from AI Gateway don't surface cf-aig-log-id on the proxied
      // SSE response.
      const row = await persistChat(env, {
        userEmail,
        model: model.id,
        model_type: "chat",
        system_prompt: body.system_prompt ?? null,
        user_input: body.user_input,
        output: accumulated,
        output_artifact: null,
        attachments: persistedAtt,
        tokens_in: usageIn,
        tokens_out: usageOut,
        latency_ms: latency,
        ai_gateway_log_id: null,
        retrieved_context: allRetrieved.length ? allRetrieved : null,
        conversation_id: conversationId,
        turn_index: turnIndex,
        project_id: scopedProjectId ?? null,
      });

      await emit({
        type: "done",
        row_id: row.id,
        latency_ms: latency,
        tokens_in: usageIn,
        tokens_out: usageOut,
        conversation_id: conversationId,
        turn_index: turnIndex,
      });
    } catch (err) {
      // Self-triggered AbortError (we aborted because client disconnected)
      // is expected; suppress it. Anything else is surfaced to the client
      // as a terminal error event.
      if (err instanceof Error && err.name === "AbortError") return;
      const m = err instanceof Error ? err.message : String(err);
      await emit({ type: "error", message: m });
    } finally {
      try { await writer.close(); } catch { /* writer may already be closed */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Disable any in-path buffering. Cloudflare doesn't buffer streaming
      // responses but downstream proxies (Nginx etc.) might; this is the
      // standard hint to flush per-event.
      "x-accel-buffering": "no",
    },
  });
}

// ---------- Video generation (Unified Billing via env.AI.run) ----------
//
// As of Cloudflare Agents Week 2026 (April 2026), the AI Gateway and Workers
// AI are unified. Third-party video models are callable via env.AI.run with
// model strings like "google/veo-3.1-fast" or "xai/grok-imagine-video".
// Cloudflare bills your account directly under Unified Billing. See:
//   https://developers.cloudflare.com/ai-gateway/features/unified-billing/
//   https://developers.cloudflare.com/ai/models/google/veo-3.1-fast/
//
// Video gen takes 30s-3min. env.AI.run for these models blocks until
// completion, which exceeds the ~30s waitUntil budget after an HTTP response.
// Cloudflare Workflows (v0.12.0+): the runVideo handler creates a
// LongRunWorkflow instance, persists its ID on the row, and returns
// immediately. The workflow class holds the long blocking env.AI.run call
// alive across step boundaries, then downloads and finalizes D1.
//
// The frontend polls /api/job/:id for status (reads D1 only; the workflow
// updates the row when done).

export async function runVideo(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  void ctx;
  const userEmail = await getUserEmail(request, env);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  void ctxOrErr; // credentials validated; workflow loads them from D1 by userEmail
  const startedAt = new Date().toISOString();

  // Image-to-video models (e.g. alibaba/hh1-i2v, flagged "image-input") need a
  // source image (v0.21.6). Three sources, resolved into one of two workflow
  // params: an uploaded attachment or an R2 key (image_key, e.g. a prior
  // nano-banana output for chaining) -> `imageKey`, resolved to a data: URI in
  // the workflow; a fetchable external URL (image_url) -> `imageUrl`, passed
  // through. Uploads are stored to R2 here so the (potentially multi-MB) image
  // doesn't ride the Workflow event payload (~1 MiB cap); the small key does.
  const needsImage = model.capabilities.includes("image-input");
  let srcImageKey: string | undefined;
  let srcImageUrl: string | undefined;
  if (needsImage) {
    const imgAtt = (body.attachments ?? []).find((a) => a.type === "image" && a.data);
    if (imgAtt && imgAtt.type === "image" && imgAtt.data) {
      const parsed = parseDataUrl(imgAtt.data);
      if (!parsed) {
        return json({ error: "Attached image is not a base64 data URL." }, { status: 400 });
      }
      srcImageKey = await r2Put(env, "in", parsed.mime, base64ToBytes(parsed.base64), userEmail);
    } else if (body.image_key && body.image_key.trim()) {
      srcImageKey = body.image_key.trim();
    } else if (body.image_url && body.image_url.trim()) {
      srcImageUrl = body.image_url.trim();
    } else {
      return json({ error: "This image-to-video model requires a source image: attach one, or pass 'image_key' (an R2 key) or 'image_url' (a fetchable URL)." }, { status: 400 });
    }
  }

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "video",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output: "",
    output_artifact: null,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: 0,
    ai_gateway_log_id: null,
    status: "pending",
    job_id: null,
    job_provider: model.provider ?? null,
    job_error: null,
    job_started_at: startedAt,
  });

  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: {
        rowId: row.id,
        userEmail,
        modelId: model.id,
        prompt: body.user_input,
        imageUrl: srcImageUrl,
        imageKey: srcImageKey,
        kind: "video",
        startedAtIso: startedAt,
      } satisfies LongRunParams,
    });
    instanceId = instance.id;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
      .bind(`Workflow create failed: ${m}`.slice(0, 1000), row.id)
      .run();
    return json({ error: `Failed to start video generation: ${m}` }, { status: 502 });
  }

  // Persist the workflow instance ID on the row for traceability.
  await env.DB.prepare(`UPDATE chats SET job_id = ? WHERE id = ?`)
    .bind(instanceId, row.id)
    .run();

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "video",
    output: "",
    output_artifact: null,
    status: "pending",
    job_started_at: startedAt,
    job_id: instanceId,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- Job polling endpoint ----------
//
// Reflects the current D1 row state. Long-running video/music jobs are owned
// by LongRunWorkflow instances, which update the row when they finish.

export async function handleJobPoll(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  const row = await env.DB.prepare(
    `SELECT id, status, job_error, job_started_at, output_artifact, latency_ms,
            job_id, job_provider, model_type
       FROM chats
      WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{
      id: number;
      status: string;
      job_error: string | null;
      job_started_at: string | null;
      output_artifact: string | null;
      latency_ms: number | null;
      job_id: string | null;
      job_provider: string | null;
      model_type: string;
    }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  // Terminal states return immediately.
  if (row.status === "done") {
    return json({
      id: row.id,
      status: "done",
      output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
      latency_ms: row.latency_ms,
    });
  }
  if (row.status === "failed") {
    return json({ id: row.id, status: "failed", job_error: row.job_error });
  }

  // Pending (Unified Billing video/music via LongRunWorkflow). The workflow
  // updates D1 when its work completes; this endpoint just reflects current
  // row state.
  return json({ id: row.id, status: "pending" });
}

