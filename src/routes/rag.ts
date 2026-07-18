// RAG engine: document text extraction, embedding, ingestion, retrieval, and
// optional web search. This is a support library (no route handlers): the
// documents routes ingest through it, the chat routes retrieve through it, and
// the LongRunWorkflow re-ingests zip entries through it. Kept as one module
// because embedBatch and the embedding-model constants are shared by the
// ingestion and retrieval halves.

import { getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";
import type { Env } from "../env";
import { aiRun, type AiContext } from "../ai-binding";
import { loadGatewayCredentials, GATEWAY_NOT_CONFIGURED_MSG } from "../gateway-credentials";
import { chunkText } from "../chunking";
import { searchSearxngWeb } from "../searxng";
import { r2Put, r2DeleteSafe } from "./shared";
import type { RetrievedChunk, RetrievedWebResult } from "./shared";

// ---------- RAG: document ingestion (Pass 1) ----------
//
// Pass 1 supports text/markdown only. Uploaded files are stored in R2,
// chunked, embedded with @cf/baai/bge-base-en-v1.5 (768-dim), and the
// resulting vectors are upserted into the Vectorize index. Chunks remain
// in D1 keyed by their Vectorize vector_id so retrieval can look up the
// original text from a vector hit.
//
// Chunking is character-based with ~50 char overlap. We try to break on
// natural boundaries (paragraph breaks, then newlines, then sentences)
// before falling back to a hard cut. Target 500 chars per chunk - small
// enough that BGE-base does well, large enough that each chunk carries
// usable context.
//
// Pass 2 will add the retrieval injection path into /api/chat. Pass 1
// only builds the ingestion pipeline so we can validate Vectorize +
// chunking + embedding end-to-end before touching chat.

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIMENSIONS = 768;
export const EMBED_BATCH_SIZE = 16;       // BGE accepts batches; 16 keeps requests small
export const DOC_MAX_BYTES = 10 * 1024 * 1024;  // 10MB upload cap

// v0.25.0: ZIP import (RAG). A .zip upload is expanded and each inner file is
// ingested as its own document. The compressed archive still rides the 10MB
// DOC_MAX_BYTES cap above; these bound the decompressed expansion (zip-bomb
// guard) and the inner-file count.
export const ZIP_MAX_ENTRIES = 200;
export const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const ZIP_MAX_FILE_BYTES = DOC_MAX_BYTES;

// Best-effort content type for a file pulled out of a zip (we only get a name,
// not a mime). extractChunks routes PDFs/spreadsheets by extension regardless,
// so this only affects the contentType stored on the R2 object.
export function mimeFromName(name: string): string {
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls": return "application/vnd.ms-excel";
    case "md": case "markdown": return "text/markdown";
    case "csv": return "text/csv";
    case "json": return "application/json";
    case "html": case "htm": return "text/html";
    case "xml": return "application/xml";
    case "txt": case "log": case "yaml": case "yml": return "text/plain";
    default: return "application/octet-stream";
  }
}

// v0.17.0: web-search retrieval limits and timeouts. Each upstream is
// time-bounded per source so a slow SearXNG doesn't block Wikipedia.
// Counts kept small to bound context-token spend when the toggle is on.
// v0.166.0: SearXNG replaced the retired Tavily + Brave SaaS sources.
export const SEARXNG_MAX_RESULTS   = 5;
export const WIKIPEDIA_MAX_RESULTS = 3;
export const WEB_SEARCH_TIMEOUT_MS = 8000;

// v0.23.0: RAG document upload accepts any file type (no allowlist). PDF and
// XLSX/XLS get native per-page / per-sheet extraction; everything else is
// decoded as UTF-8 text (covers txt, md, csv, json, html, source code, logs,
// etc. regardless of extension or mime). extractChunks rejects only files
// whose bytes don't decode to usable text (binary formats like .docx/.png/.zip).

export interface DocumentRow {
  id: number;
  user_email: string;
  created_at: string;
  filename: string;
  mime: string;
  r2_key: string;
  size_bytes: number;
  total_chars: number;
  chunk_count: number;
}

export interface ChunkRow {
  id: number;
  document_id: number;
  user_email: string;
  chunk_index: number;
  text: string;
  vector_id: string;
  page: number | null;
  sheet: string | null;
}

// Output of the per-format extractors. Each ExtractedChunk has text plus
// optional source-location metadata that gets persisted on the chunk row.
export interface ExtractedChunk {
  text: string;
  page?: number;     // PDF: 1-indexed page number
  sheet?: string;    // XLSX/XLS: source sheet name
}

// ---------- RAG Phase 3A: per-format text extraction ----------
//
// For PDFs we extract per-page using unpdf (a serverless-friendly PDF.js
// wrapper) and tag each resulting chunk with its source page. Chunks never
// cross page boundaries so the source-page metadata stays meaningful.
//
// For XLSX/XLS we use SheetJS's CSV exporter per sheet and tag each chunk
// with its source sheet name. Same boundary rule: chunks never cross sheets.
//
// Scanned/image-only PDFs are not handled here; pdfjs extracts the empty
// text layer they have, which gives few or zero chunks. A future Phase 3B
// would render pages to PNG and run them through a vision model for OCR.

export async function extractPdfChunks(bytes: Uint8Array): Promise<ExtractedChunk[]> {
  const pdf = await getDocumentProxy(bytes);
  const out: ExtractedChunk[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // pdfjs's text items have a .str field; join with spaces and collapse
    // runs of whitespace that come from rendering positioning.
    const raw = (content.items as Array<{ str?: string }>)
      .map((it) => (it.str ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s+\n/g, "\n")
      .trim();
    if (!raw) continue;
    for (const piece of chunkText(raw)) {
      out.push({ text: piece, page: i });
    }
  }
  return out;
}

export function extractXlsxChunks(bytes: Uint8Array): ExtractedChunk[] {
  // SheetJS read accepts ArrayBuffer-ish inputs; dense=true uses a
  // 2D-array internal layout which is faster on sparse sheets.
  const wb = XLSX.read(bytes, { type: "array", dense: true });
  const out: ExtractedChunk[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, strip: true });
    const text = csv.trim();
    if (!text) continue;
    // For a small sheet, the whole CSV may be one chunk. For a large sheet,
    // chunkText breaks on newlines (the row boundaries in CSV).
    for (const piece of chunkText(text)) {
      out.push({ text: piece, sheet: sheetName });
    }
  }
  return out;
}

// v0.23.0: heuristic: is a decoded string actually binary data we failed to
// read as text? A meaningful fraction of U+FFFD (UTF-8 replacement) or C0 control
// codes other than the usual whitespace (tab, LF, CR) means the source was
// binary (zipped office docs, images, archives). Text-based formats stay far
// below the threshold. Sample the head to keep this O(1)-ish on big files.
export function looksBinary(text: string): boolean {
  if (!text) return true;
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd) { bad++; continue; }
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) bad++;
  }
  return bad / sample.length > 0.1;
}

// Per-mime dispatcher. Returns ExtractedChunk[] regardless of input format.
// The caller is responsible for storing the raw bytes in R2 and persisting
// each chunk row with its page/sheet metadata.
export async function extractChunks(bytes: Uint8Array, mime: string, filename: string): Promise<ExtractedChunk[]> {
  const ext = (filename.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

  // PDF
  if (mime === "application/pdf" || ext === "pdf") {
    return await extractPdfChunks(bytes);
  }

  // XLSX or XLS
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    ext === "xlsx" || ext === "xls"
  ) {
    return extractXlsxChunks(bytes);
  }

  // Everything else: treat as UTF-8 text. Covers txt/md plus any code, CSV,
  // JSON, HTML, log, or other text-based format, whatever the extension.
  // Decode with replacement on invalid bytes rather than throwing; if the
  // result is mostly replacement/control bytes the file is binary in a format
  // we can't extract, so reject it instead of embedding garbage.
  const text = new TextDecoder("utf-8").decode(bytes);
  if (looksBinary(text)) {
    throw new Error(
      `${filename} looks like binary data that can't be read as text. PDF and ` +
      `XLSX/XLS are extracted natively; otherwise upload a text-based file ` +
      `(txt, md, csv, json, html, source code, etc.).`
    );
  }
  return chunkText(text).map((t) => ({ text: t }));
}

export async function embedBatch(env: Env, userEmail: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const gateway = await loadGatewayCredentials(env, userEmail);
  if (!gateway?.gatewayId) {
    throw new Error(GATEWAY_NOT_CONFIGURED_MSG);
  }
  const aiCtx: AiContext = { env, gateway };
  const result = await aiRun(aiCtx, EMBED_MODEL, { text: texts }) as {
    shape?: [number, number];
    data?: number[][];
  };
  if (!result.data || !Array.isArray(result.data)) {
    throw new Error("Embedding model returned no data array");
  }
  return result.data;
}

// ---------- RAG: retrieval (Pass 2) ----------
//
// Embeds the user prompt, queries Vectorize for the top-K nearest chunks,
// then looks up source text in D1. We filter by user_email in the D1 JOIN
// (not in the Vectorize filter param) so this works without a metadata
// index on the Vectorize side - simpler for single-user deployments.
// Vectorize score ordering is preserved.

export const RETRIEVE_TOP_K = 5;

export async function retrieveContext(
  env: Env,
  userEmail: string,
  queryText: string,
  topK: number = RETRIEVE_TOP_K,
  projectId?: number,
): Promise<{ chunks: RetrievedChunk[]; error: string | null }> {
  if (!queryText || !queryText.trim()) {
    return { chunks: [], error: "Empty query text" };
  }

  // 1) Embed the query. Log + surface errors instead of silently swallowing.
  let queryVec: number[];
  try {
    const vectors = await embedBatch(env, userEmail, [queryText]);
    if (vectors.length === 0) {
      const msg = "Embed returned no vectors";
      console.error("retrieveContext:", msg);
      return { chunks: [], error: msg };
    }
    queryVec = vectors[0];
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: embed failed:", m);
    return { chunks: [], error: `embed failed: ${m}` };
  }

  // 2) Query Vectorize. No metadata filter - we scope by user in D1 below.
  // When projectId is set, we overfetch (3x topK) at the Vectorize stage
  // and filter by project membership in D1, since Vectorize doesn't know
  // about project membership. Without overfetch, a small topK that all
  // misses the project would return zero results even when the project
  // has relevant chunks.
  const vectorizeTopK = projectId !== undefined ? topK * 3 : topK;
  let matches: { id: string; score: number }[];
  try {
    const q = await env.VEC.query(queryVec, { topK: vectorizeTopK });
    matches = (q?.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: vectorize query failed:", m);
    return { chunks: [], error: `vectorize query failed: ${m}` };
  }
  if (matches.length === 0) {
    console.warn("retrieveContext: vectorize returned 0 matches for query");
    return { chunks: [], error: "vectorize returned 0 matches" };
  }

  // 3) D1 lookup: join chunks to documents, scope by user_email so we
  // never return another user's chunk even if their vector IDs would
  // somehow collide. When projectId is set, additionally INNER JOIN
  // project_documents so only chunks whose document is in that project's
  // membership set come through.
  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  let rows;
  try {
    if (projectId !== undefined) {
      rows = await env.DB.prepare(
        `SELECT c.document_id, c.chunk_index, c.text, c.vector_id, c.page, c.sheet, d.filename
           FROM chunks c
           JOIN documents d           ON c.document_id = d.id
           JOIN project_documents pd  ON pd.document_id = d.id
           JOIN projects p            ON p.id = pd.project_id
          WHERE c.user_email = ?
            AND p.user_email = ?
            AND pd.project_id = ?
            AND c.vector_id IN (${placeholders})`
      )
        .bind(userEmail, userEmail, projectId, ...ids)
        .all<{ document_id: number; chunk_index: number; text: string; vector_id: string; filename: string; page: number | null; sheet: string | null }>();
    } else {
      rows = await env.DB.prepare(
        `SELECT c.document_id, c.chunk_index, c.text, c.vector_id, c.page, c.sheet, d.filename
           FROM chunks c
           JOIN documents d ON c.document_id = d.id
          WHERE c.user_email = ?
            AND c.vector_id IN (${placeholders})`
      )
        .bind(userEmail, ...ids)
        .all<{ document_id: number; chunk_index: number; text: string; vector_id: string; filename: string; page: number | null; sheet: string | null }>();
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: D1 lookup failed:", m);
    return { chunks: [], error: `D1 lookup failed: ${m}` };
  }

  const results = rows.results ?? [];
  if (results.length === 0) {
    // Vectorize had matches but D1 join returned nothing. Two causes:
    //   1. user_email mismatch (vectors written under a different identity).
    //   2. With projectId set: matches were real but none of the matched
    //      documents are members of the requested project.
    const idSample = ids.slice(0, 3).join(", ");
    const scope = projectId !== undefined ? ` project_id=${projectId},` : "";
    const msg = `Vectorize returned ${matches.length} matches but D1 join returned 0. user_email='${userEmail}',${scope} sample vector_ids=[${idSample}]. Check whether vectors were upserted under a different user identity, or whether the project has any document members.`;
    console.warn("retrieveContext:", msg);
    return { chunks: [], error: msg };
  }

  // 4) Merge scores back in, preserve Vectorize ordering. When projectId
  // is set we overfetched from Vectorize (3x topK), so cap output here to
  // hold the chat prompt size to the caller's intended top-K.
  const byId = new Map(results.map((r) => [r.vector_id, r]));
  const scoreById = new Map(matches.map((m) => [m.id, m.score]));
  const out: RetrievedChunk[] = [];
  for (const id of ids) {
    if (out.length >= topK) break;
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      document_id: r.document_id,
      filename: r.filename,
      chunk_index: r.chunk_index,
      text: r.text,
      score: scoreById.get(id) ?? 0,
      page: r.page,
      sheet: r.sheet,
    });
  }
  return { chunks: out, error: null };
}

export function formatRetrievalForSystemPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c, i) => {
      const loc =
        c.page !== undefined && c.page !== null ? `, page ${c.page}` :
        c.sheet ? `, sheet "${c.sheet}"` :
        "";
      return `[Excerpt ${i + 1}, from ${c.filename}${loc} (chunk ${c.chunk_index})]\n${c.text}`;
    })
    .join("\n\n---\n\n");
  return [
    "You have access to the following excerpts from the user's uploaded documents.",
    "Use them when they are relevant to the user's query. If they don't answer the question,",
    "say so plainly rather than guessing or hallucinating.",
    "",
    body,
  ].join("\n");
}

// ---------- Web search (v0.17.0) ----------
//
// Optional retrieval source: SearXNG (self-hosted metasearch) for general web,
// Wikipedia for lore / reference. Both run in parallel; failure of one doesn't
// kill the other. Per-source timeouts (WEB_SEARCH_TIMEOUT_MS) prevent a slow
// upstream from blocking the whole turn.
//
// SearXNG requires SEARXNG_URL; when unset, that source is silently skipped.
// Wikipedia needs no config. (v0.166.0: SearXNG replaced the retired Tavily +
// Brave SaaS sources; see prism#93.)
//
// Results are persisted to the existing retrieved_context column alongside
// RAG chunks, with source_type discriminator. The frontend renders branches
// on source_type to show the source URL for web results.

export async function searchWeb(
  env: Env,
  query: string
): Promise<{ results: RetrievedWebResult[]; error: string | null }> {
  const q = query.trim();
  if (!q) return { results: [], error: null };

  // Each upstream is wrapped in its own timeout + catch so a single failure
  // doesn't abort the other. Partial results are better than nothing.
  const searxngPromise: Promise<RetrievedWebResult[]> = env.SEARXNG_URL
    ? searchSearxng(env, q).catch(() => [])
    : Promise.resolve([]);
  const wikipediaPromise: Promise<RetrievedWebResult[]> = searchWikipedia(q).catch(() => []);

  const [searxng, wikipedia] = await Promise.all([searxngPromise, wikipediaPromise]);
  const results = [...searxng, ...wikipedia];

  // Empty results is fine; it just means the query didn't match anything in
  // any source. Real per-source failures are swallowed by the .catch above
  // so the other source can still return its hits.
  return { results, error: null };
}

export async function searchSearxng(env: Env, query: string): Promise<RetrievedWebResult[]> {
  // Access service-token headers are sent only when both halves are set, so an
  // un-gated self-hosted instance is reached with no headers.
  const hits = await searchSearxngWeb(env.SEARXNG_URL!, query, {
    maxResults: SEARXNG_MAX_RESULTS,
    timeoutMs: WEB_SEARCH_TIMEOUT_MS,
    accessClientId: env.SEARXNG_ACCESS_CLIENT_ID,
    accessClientSecret: env.SEARXNG_ACCESS_CLIENT_SECRET,
  });
  return hits.map((r): RetrievedWebResult => ({
    source_type: "web",
    source: "searxng",
    url: r.url,
    title: r.title,
    snippet: r.snippet,
  }));
}

export async function searchWikipedia(query: string): Promise<RetrievedWebResult[]> {
  // Wikipedia's search endpoint returns titles + HTML snippets in one call.
  // origin=* is required for CORS, but harmless server-side too. We don't
  // hit /page/summary per result (would be N+1 round-trips); the search
  // snippet is enough for most creative-work queries.
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", String(WIKIPEDIA_MAX_RESULTS));
  url.searchParams.set("srprop", "snippet");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const resp = await fetch(url.toString(), {
    headers: {
      // Wikimedia asks for a descriptive User-Agent identifying the tool.
      // See https://meta.wikimedia.org/wiki/User-Agent_policy
      "user-agent": "skyphusion-llm-public/0.17.0 (https://github.com/SkyPhusion/skyphusion-llm-public)",
    },
    signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Wikipedia ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json() as {
    query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
  };
  const items = data.query?.search ?? [];
  return items
    .filter((r) => r.title && r.pageid !== undefined)
    .map((r): RetrievedWebResult => ({
      source_type: "web",
      source: "wikipedia",
      url: `https://en.wikipedia.org/?curid=${r.pageid}`,
      title: r.title!,
      // Snippet comes back as HTML with <span class="searchmatch">...</span>
      // around matched terms. Strip tags and decode the few entities that
      // Wikipedia commonly emits. Good enough for an LLM context block.
      snippet: stripWikipediaSnippet(r.snippet ?? ""),
    }));
}

export function stripWikipediaSnippet(html: string): string {
  // Strip HTML tags to a fixpoint first, so a reassembled/nested tag (e.g.
  // "<<script>script>") can't survive a single pass, THEN decode the handful of
  // entities Wikipedia emits -- decoding &amp; LAST so an encoded entity like
  // "&amp;lt;" stays literal text instead of being double-unescaped into "<".
  // Output is plain text for an LLM context block (not an HTML/DOM sink).
  let prev = "";
  let s = html;
  while (s !== prev) {
    prev = s;
    s = s.replace(/<[^>]+>/g, "");
  }
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function webSourceSystemLabel(source: RetrievedWebResult["source"]): string {
  switch (source) {
    case "searxng": return "Web";
    case "wikipedia": return "Wikipedia";
  }
}

export function formatWebForSystemPrompt(results: RetrievedWebResult[]): string {
  if (results.length === 0) return "";
  const body = results
    .map((r, i) => {
      const sourceLabel = webSourceSystemLabel(r.source);
      return `[${sourceLabel} ${i + 1}, "${r.title}" (${r.url})]\n${r.snippet}`;
    })
    .join("\n\n---\n\n");
  return [
    "You have access to the following snippets retrieved from web search.",
    "Treat these as supplementary context, not authoritative fact. Quote URLs",
    "verbatim if citing a source. If the snippets don't answer the question,",
    "say so plainly rather than fabricating.",
    "",
    body,
  ].join("\n");
}

// Result of ingesting a single file into the RAG store. Returned (not a
// Response) so both the single-file upload path and the per-entry zip-import
// path can compose it.
export type IngestResult =
  | { ok: true; id: number; created_at: string; filename: string; mime: string; size_bytes: number; total_chars: number; chunk_count: number }
  | { ok: false; status: number; error: string };

// Core RAG ingest for one file: extract -> store raw bytes in R2 -> insert the
// document row -> embed in batches and upsert vectors -> write chunk rows.
// Extracted from handleDocumentUpload (v0.25.0) so ZIP import can reuse it
// per inner file. Best-effort rollback on embedding failure.
export async function ingestDocument(env: Env, userEmail: string, filename: string, mime: string, bytes: Uint8Array): Promise<IngestResult> {
  let extracted: ExtractedChunk[];
  try {
    extracted = await extractChunks(bytes, mime, filename);
  } catch (err) {
    return { ok: false, status: 400, error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (extracted.length === 0) {
    return { ok: false, status: 400, error: "No chunks produced (empty, image-only/scanned PDF, or unreadable format)." };
  }

  const totalChars = extracted.reduce((sum, c) => sum + c.text.length, 0);

  // Store raw bytes in R2 for audit / future re-processing.
  const r2Key = await r2Put(env, "in", mime, bytes, userEmail);

  // Insert document row first so we have its ID for vector_id generation.
  const docInsert = await env.DB.prepare(
    `INSERT INTO documents
       (user_email, filename, mime, r2_key, size_bytes, total_chars, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(userEmail, filename, mime, r2Key, bytes.length, totalChars, extracted.length)
    .first<{ id: number; created_at: string }>();
  if (!docInsert) {
    await r2DeleteSafe(env, r2Key);
    return { ok: false, status: 500, error: "Failed to insert document row" };
  }
  const docId = docInsert.id;

  // Embed in batches and upsert to Vectorize. We tag every vector with
  // user_email + document_id so we can filter on retrieval and clean up on delete.
  // Vector IDs are scoped: `${userEmail}:${docId}:${chunkIndex}`.
  const vectorIdsWritten: string[] = [];
  const chunkRowsToInsert: {
    chunk_index: number;
    text: string;
    vector_id: string;
    page: number | null;
    sheet: string | null;
  }[] = [];

  try {
    for (let b = 0; b < extracted.length; b += EMBED_BATCH_SIZE) {
      const batch = extracted.slice(b, b + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(env, userEmail, batch.map((c) => c.text));
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding batch returned ${vectors.length} vectors for ${batch.length} texts`);
      }

      const vectorizePayload = batch.map((c, i) => {
        const idx = b + i;
        const vid = `${userEmail}:${docId}:${idx}`;
        chunkRowsToInsert.push({
          chunk_index: idx,
          text: c.text,
          vector_id: vid,
          page: c.page ?? null,
          sheet: c.sheet ?? null,
        });
        vectorIdsWritten.push(vid);
        const metadata: Record<string, string | number> = {
          user_email: userEmail,
          document_id: docId,
          chunk_index: idx,
        };
        if (c.page !== undefined) metadata.page = c.page;
        if (c.sheet !== undefined) metadata.sheet = c.sheet;
        return { id: vid, values: vectors[i], metadata };
      });

      await env.VEC.upsert(vectorizePayload);
    }
  } catch (err) {
    // Rollback: best-effort cleanup of partially-written state.
    if (vectorIdsWritten.length) {
      try { await env.VEC.deleteByIds(vectorIdsWritten); } catch { /* swallow */ }
    }
    await env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(docId).run();
    await r2DeleteSafe(env, r2Key);
    return { ok: false, status: 502, error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Now write all chunk rows in a single batched D1 statement.
  if (chunkRowsToInsert.length) {
    const stmts = chunkRowsToInsert.map((c) =>
      env.DB.prepare(
        `INSERT INTO chunks (document_id, user_email, chunk_index, text, vector_id, page, sheet)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(docId, userEmail, c.chunk_index, c.text, c.vector_id, c.page, c.sheet)
    );
    await env.DB.batch(stmts);
  }

  return {
    ok: true,
    id: docId,
    created_at: docInsert.created_at,
    filename,
    mime,
    size_bytes: bytes.length,
    total_chars: totalChars,
    chunk_count: extracted.length,
  };
}

