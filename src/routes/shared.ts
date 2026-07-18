// Shared request/response + storage primitives and cross-cutting types used by
// the route modules under src/routes/. index.ts constructs the fetch route
// table and delegates to those modules; the helpers and types they all lean on
// (the JSON envelope, identity resolution, the AI-gateway gate, the R2 storage
// primitives, and the persisted-row/retrieval type shapes) live here so no
// route module has to import another just to reach them.

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import type { InputAttachment } from "../types";
import { extFromMime, bytesToBase64 } from "../utils";
import { type AiContext } from "../ai-binding";
import {
  loadGatewayCredentials,
  GATEWAY_NOT_CONFIGURED_MSG,
  CF_AIG_TOKEN_REQUIRED_MSG,
} from "../gateway-credentials";
import { resolveIdentity } from "../auth";

// ---------- Types ----------

export interface ChatRequest {
  model: string;
  system_prompt?: string;
  user_input: string;
  attachments?: InputAttachment[];
  image_url?: string;   // v0.21.5: source image for image-to-video models (hh1-i2v); a fetchable URL
  image_key?: string;   // v0.21.6: source image as an R2 key (e.g. a prior nano-banana output) for image-to-video chaining
  use_docs?: boolean;   // Pass 2: when true, retrieve top-K chunks from Vectorize and inject as context
  use_web_search?: boolean;  // v0.17.0: when true, query SearXNG + Wikipedia and inject snippets as context
  conversation_id?: string;  // Multi-turn: when present, continue an existing conversation
  project_id?: number;  // v0.20.0: when present, scope RAG retrieval to the project's docs
                        // and apply the project's system_prompt as default if system_prompt is empty
}

export interface RetrievedChunk {
  // v0.17.0: discriminator. Omitted on existing rows (pre-v0.17.0) and on new
  // RAG-only rows; readers treat "missing" as "rag" for back-compat.
  source_type?: "rag";
  document_id: number;
  filename: string;
  chunk_index: number;
  text: string;
  score: number;
  page?: number | null;     // PDFs only
  sheet?: string | null;    // XLSX/XLS only
}

// v0.17.0: web-search result, stored alongside RAG chunks in the same
// retrieved_context column. The frontend renders branches on source_type.
export interface RetrievedWebResult {
  source_type: "web";
  source: "searxng" | "wikipedia";
  url: string;
  title: string;
  snippet: string;          // already HTML-stripped
  score?: number;           // kept for back-compat with pre-v0.166.0 rows (Tavily scores); unset now
}

export type RetrievedItem = RetrievedChunk | RetrievedWebResult;

export interface PersistedImageAttachment {
  type: "image";
  key: string;
  mime?: string;
  filename?: string;
}
export interface PersistedAudioAttachment {
  type: "audio";
  mime?: string;
  filename?: string;
  transcript: string | null;
}
export interface PersistedVideoFramesAttachment {
  type: "video_frames";
  keys: string[];
  frame_count: number;
  duration?: number;
  filename?: string;
}
export interface PersistedVideoFullAttachment {
  type: "video_full";
  key: string;
  mime?: string;
  filename?: string;
}
// v0.24.0: inline text-file attachment. The contents are folded into the
// prompt (not stored in R2); we persist only metadata so history can show
// that a file was attached without bloating D1 with the full text.
export interface PersistedDocumentAttachment {
  type: "document";
  mime?: string;
  filename?: string;
  chars: number;
}
export type PersistedAttachment =
  | PersistedImageAttachment
  | PersistedAudioAttachment
  | PersistedVideoFramesAttachment
  | PersistedVideoFullAttachment
  | PersistedDocumentAttachment;

export interface OutputArtifact {
  key: string;
  mime: string;
  type: "image" | "audio" | "video";
}

// ---------- Helpers ----------

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

// Identity read site #1 (HTTP). Delegates to resolveIdentity so access-mode and
// public-mode derivation stay in one place. In access mode this is never null.
// In public mode the router gate rejects unauthenticated /api/* with 401 before
// any handler runs, so a null here is an unreachable, fail-closed error rather
// than a silent anonymous cross-attribution.
export async function getUserEmail(request: Request, env: Env): Promise<string> {
  const id = await resolveIdentity(request, env);
  if (id === null) throw new Error("unauthenticated request reached an owned handler");
  return id;
}

export function modelNeedsCfAigToken(model: ModelEntry): boolean {
  return !!model.provider && model.provider !== "workers-ai";
}

export async function requireAiContext(
  env: Env,
  userEmail: string,
  opts?: { requireCfToken?: boolean },
): Promise<AiContext | Response> {
  const gateway = await loadGatewayCredentials(env, userEmail);
  if (!gateway?.gatewayId) {
    return json({ error: GATEWAY_NOT_CONFIGURED_MSG, code: "gateway_not_configured" }, { status: 412 });
  }
  if (opts?.requireCfToken && !gateway.cfAigToken) {
    return json({ error: CF_AIG_TOKEN_REQUIRED_MSG, code: "cf_aig_token_required" }, { status: 412 });
  }
  return { env, gateway };
}

export async function r2Put(env: Env, prefix: "in" | "out", mime: string, bytes: Uint8Array, userEmail: string): Promise<string> {
  const key = `${prefix}/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { user_email: userEmail },
  });
  return key;
}


// Read an R2 object and return it as a base64 `data:` URI. Used to inline a
// source image for image-to-video (hh1-i2v): the upstream accepts data URIs
// (verified, it re-uploads them to its own OSS), so we don't need a presigned
// GET URL. Ownership is enforced the same way /api/artifact does: the object's
// customMetadata.user_email must match, so a client can't reference another
// user's R2 key via image_key. Throws on miss or ownership mismatch.
export async function r2KeyToDataUri(env: Env, key: string, userEmail: string): Promise<string> {
  const obj = await env.R2.get(key);
  if (!obj) throw new Error(`source image not found: ${key}`);
  if (obj.customMetadata?.user_email !== userEmail) {
    throw new Error(`source image not owned by requester: ${key}`);
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const mime = obj.httpMetadata?.contentType || "image/png";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// Attachment-by-reference (v0.21.7): an image or full-video attachment may
// carry an R2 `key` (an artifact already produced in this conversation)
// instead of inline `data`. Hydrate `data` from R2 once, here at the request
// boundary, so every downstream consumer (vision chat, FLUX.2 reference
// images, image-to-video) works unchanged. Ownership is enforced by
// r2KeyToDataUri. This is what lets a model use what a previous model in the
// same conversation generated, with no download/re-upload.
export async function resolveAttachmentKeys(env: Env, attachments: InputAttachment[], userEmail: string): Promise<InputAttachment[]> {
  return Promise.all(attachments.map(async (att) => {
    if ((att.type === "image" || att.type === "video_full") && att.key && !att.data) {
      return { ...att, data: await r2KeyToDataUri(env, att.key, userEmail) };
    }
    return att;
  }));
}

export async function r2DeleteSafe(env: Env, key: string): Promise<void> {
  try { await env.R2.delete(key); } catch { /* ignore */ }
}

export function safeParseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

