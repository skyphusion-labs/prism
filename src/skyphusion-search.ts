// skyphusion-search retrieval, via the SEARCH service binding.
//
// Contract pinned from skyphusion-labs/search-mcp (PR #147). The worker
// exports a named entrypoint SearchEntrypoint. The caller selects it
// with wrangler `entrypoint = "SearchEntrypoint"` on the service
// binding. Internet fetch still hits the default export, so this client
// does not call POST /ask and does not send an Origin header.
//
// search(question: string) returns { chunks }. Fields used here match
// AiSearchChunk: score, text, item.key, item.metadata.repo,
// item.metadata.path. Chunks carry no URL. A hit links to
// https://github.com/skyphusion-labs/<repo>/blob/main/<path>, the
// public corpus that worker indexes. metadata.path wins over the R2
// key. A path taken from the key drops a trailing ".txt" that corpus
// ingest adds (same rule as search-mcp src/mcp.ts mapSearchChunks).
//
// The question must be a non-empty string of at most 2000 characters
// after trim. A bad call throws Error with one of these messages:
// empty_question, question_too_long, rate_limited, search_unavailable.
// The caller reports that message as sources.web error and status
// "failed". An empty chunks array is zero hits, not a failure. A
// missing binding is "absent", and the caller decides that before
// this function runs.

import type { SearchChunk, SearchEntrypoint } from "./env";

const GITHUB_BLOB = "https://github.com/skyphusion-labs";
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

function repoAndPath(chunk: SearchChunk): { repo: string; path: string } | null {
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

export function mapSearchChunks(chunks: readonly SearchChunk[], maxResults: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const cap = Math.max(0, maxResults);
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
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

// The RPC method takes no AbortSignal. Race a timer so a stuck call still
// fails this source inside the caller's timeout, then clear the timer so
// a fast call does not hold the process open.
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("skyphusion-search timeout")), ms);
  });
  // If the timer wins, a later rejection of `work` must not surface as
  // unhandled. The race below still rejects with the original error when
  // `work` loses first.
  void work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function askSkyphusionSearch(
  binding: Service<SearchEntrypoint>,
  query: string,
  opts: { timeoutMs: number; maxResults: number },
): Promise<SearchHit[]> {
  const question = query.trim();
  const result = await withTimeout(binding.search(question), opts.timeoutMs);
  if (!result || !Array.isArray(result.chunks)) {
    throw new Error("search_unavailable");
  }
  return mapSearchChunks(result.chunks, opts.maxResults);
}
