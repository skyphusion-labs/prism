// skyphusion-search retrieval, via the SEARCH service binding.
//
// Contract pinned 2026-11-12 from source. The live Worker script
// `skyphusion-search` is deployed from skyphusion-labs/search-mcp
// (docs/skyphusion/OPERATOR.md: worker name skyphusion-search, main
// src/index.ts). The archived skyphusion-labs/skyphusion-search repo
// exposes the same route (src/index.ts:155-156).
//
// POST /ask (search-mcp src/index.ts:205-206).
// JSON body { question, turnstileToken? } (src/index.ts:68-71).
// Origin must be on that worker's ALLOWED_ORIGINS, or the response is
// 403 { error: "origin_not_allowed" } (src/index.ts:132-134).
// A question longer than 2000 characters is 413 question_too_long
// (src/index.ts:64 and 145-146).
// Success is text/event-stream (src/index.ts:184-190), not a hit list.
// The ask widget reads an SSE event named "chunks" whose data is an array
// of objects with item.key (public/ask-widget.js:169-177 and 229-231).
// Fields used here match AiSearchChunk (src/env.ts:37-43): score, text,
// item.key, item.metadata.repo, item.metadata.path. Delta events
// (ask-widget.js:233-234) are the generated answer and are ignored.
// An event named "error", or any data payload with an error field, is a
// failure (ask-widget.js:220-227). Any non-2xx body is a failure
// (src/index.ts:132-133, 140, 146, 151, 155, 177, 181, 209).
//
// GET /health (src/index.ts:201-203) does not search. This worker has no
// JSON /search route. Chunks carry no URL; the widget resolves item.key
// through a page manifest this binding does not receive. A hit URL is
// therefore https://github.com/skyphusion-labs/<repo>/blob/main/<path>,
// the public corpus that worker indexes. metadata.path wins over the R2
// key. A path taken from the key drops a trailing ".txt" that corpus
// ingest adds (same rule as search-mcp src/mcp.ts mapSearchChunks).
//
// A service binding sends no browser Origin. The default Origin is
// https://skyphusion.net, which OPERATOR.md lists on the production
// ALLOWED_ORIGINS. env.SEARCH_ASK_ORIGIN overrides it for a self-hosted
// search worker with a different allowlist. If that worker has
// TURNSTILE_SECRET set, POST /ask returns 403 turnstile_failed
// (src/index.ts:149-152) and the caller reports this source as failed.

export const DEFAULT_SEARCH_ASK_ORIGIN = "https://skyphusion.net";
export const SEARCH_MAX_QUESTION_LEN = 2000;

const GITHUB_BLOB = "https://github.com/skyphusion-labs";
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface SearchBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// Subset of search-mcp AiSearchChunk that the chunks SSE event carries.
export interface AskChunk {
  score?: number;
  text?: string;
  item?: {
    key?: string;
    metadata?: { repo?: string; path?: string };
  };
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export function parseAskSse(body: string): AskChunk[] {
  const chunks: AskChunk[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let name = "";
    const dataLines: string[] = [];
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.replace(/\r$/, "");
      const match = /^(event|data):\s?(.*)$/.exec(line);
      if (!match) continue;
      if (match[1] === "event") name = match[2].trim();
      else dataLines.push(match[2]);
    }
    if (dataLines.length === 0) {
      if (name === "error") throw new Error("skyphusion-search stream error");
      continue;
    }
    const payload = dataLines.join("\n").trim();
    if (payload === "[DONE]") continue;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      if (name === "error") throw new Error("skyphusion-search stream error");
      continue;
    }
    if (isStreamError(name, data)) {
      throw new Error(`skyphusion-search stream error: ${streamErrorMessage(data)}`);
    }
    if (name === "chunks") {
      if (!Array.isArray(data)) {
        throw new Error("skyphusion-search chunks event was not an array");
      }
      for (const item of data) {
        if (item && typeof item === "object") chunks.push(item as AskChunk);
      }
    }
  }
  return chunks;
}

function isStreamError(name: string, data: unknown): boolean {
  if (name === "error") return true;
  return !!data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error != null;
}

function streamErrorMessage(data: unknown): string {
  const err = data && typeof data === "object" && "error" in data
    ? (data as { error?: unknown }).error
    : undefined;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "stream error";
}

function repoAndPath(chunk: AskChunk): { repo: string; path: string } | null {
  const meta = chunk.item?.metadata;
  const key = typeof chunk.item?.key === "string" ? chunk.item.key.trim() : "";
  const slash = key.indexOf("/");
  const keyRepo = slash > 0 ? key.slice(0, slash) : "";
  const keyPath = slash > 0 ? key.slice(slash + 1).replace(/\.txt$/, "") : "";
  const repo = (typeof meta?.repo === "string" ? meta.repo.trim() : "") || keyRepo;
  const path = (typeof meta?.path === "string" ? meta.path.trim() : "") || keyPath;
  if (!repo || !path) return null;
  return { repo, path };
}

function corpusUrl(repo: string, path: string): string | null {
  if (!PATH_SEGMENT.test(repo)) return null;
  const parts = path.split("/");
  // "." and ".." match the segment pattern (dots and nothing else) and must
  // still be refused, or a key can climb out of the repo path.
  if (parts.some((seg) => seg === "." || seg === ".." || !PATH_SEGMENT.test(seg))) return null;
  return `${GITHUB_BLOB}/${repo}/blob/main/${parts.map((seg) => encodeURIComponent(seg)).join("/")}`;
}

export function mapAskChunks(chunks: AskChunk[], maxResults: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const cap = Math.max(0, maxResults);
  for (const chunk of chunks) {
    const id = repoAndPath(chunk);
    if (!id) continue;
    const url = corpusUrl(id.repo, id.path);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = typeof chunk.text === "string"
      ? chunk.text.replace(/\s+/g, " ").trim()
      : "";
    const hit: SearchHit = { title: `${id.repo}/${id.path}`, url, snippet };
    if (typeof chunk.score === "number" && Number.isFinite(chunk.score)) hit.score = chunk.score;
    out.push(hit);
    if (out.length >= cap) break;
  }
  return out;
}

function errorDetail(raw: string): string {
  const sliced = raw.slice(0, 200);
  try {
    const parsed = JSON.parse(sliced) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Body was not JSON. Keep the sliced text.
  }
  return sliced.trim();
}

export async function askSkyphusionSearch(
  binding: SearchBinding,
  query: string,
  opts: { timeoutMs: number; maxResults: number; origin: string },
): Promise<SearchHit[]> {
  const question = query.trim().slice(0, SEARCH_MAX_QUESTION_LEN);
  if (!question) return [];
  const origin = opts.origin.trim() || DEFAULT_SEARCH_ASK_ORIGIN;
  const resp = await binding.fetch("https://skyphusion-search/ask", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      origin,
    },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!resp.ok) {
    const detail = errorDetail(await resp.text());
    throw new Error(detail
      ? `skyphusion-search ${resp.status}: ${detail}`
      : `skyphusion-search ${resp.status}`);
  }
  const ctype = resp.headers.get("content-type") ?? "";
  const raw = await resp.text();
  if (ctype.includes("application/json")) {
    const detail = errorDetail(raw);
    throw new Error(`skyphusion-search ${resp.status}: ${detail || "unexpected_json"}`);
  }
  return mapAskChunks(parseAskSse(raw), opts.maxResults);
}
