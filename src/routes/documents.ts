// RAG document routes: list/get documents, upload (single file or a .zip that
// fans out to a durable import workflow), poll a zip import, and delete a
// document (cascading chunks, vectors, project memberships, and R2). The
// extract/embed/ingest engine lives in ./rag.

import type { Env } from "../env";
import { parseDataUrl, base64ToBytes } from "../utils";
import { isZip } from "../zip";
import { json, getUserEmail, r2DeleteSafe } from "./shared";
import { ingestDocument, DOC_MAX_BYTES } from "./rag";
import type { LongRunParams, ZipImportSummary } from "./workflow";

export async function handleDocumentList(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const url = new URL(request.url);
  const projectIdParam = url.searchParams.get("project_id");

  // v0.20.0: optional ?project_id=N filter. When set, return only documents
  // attached to that project via project_documents. The project ownership
  // check is done by joining on projects.user_email implicitly via WHERE
  // p.user_email = ?, so attempting to filter by another user's project
  // returns an empty list rather than leaking that the project exists.
  if (projectIdParam !== null) {
    const projectId = Number(projectIdParam);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return json({ error: "project_id must be a positive integer" }, { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT d.id, d.created_at, d.filename, d.mime, d.size_bytes,
              d.total_chars, d.chunk_count
         FROM documents d
         JOIN project_documents pd ON pd.document_id = d.id
         JOIN projects p           ON p.id = pd.project_id
        WHERE d.user_email = ?
          AND p.user_email = ?
          AND pd.project_id = ?
        ORDER BY pd.added_at DESC`
    )
      .bind(userEmail, userEmail, projectId)
      .all<{
        id: number;
        created_at: string;
        filename: string;
        mime: string;
        size_bytes: number;
        total_chars: number;
        chunk_count: number;
      }>();
    return json({
      user: userEmail,
      project_id: projectId,
      documents: rows.results ?? [],
    });
  }

  const rows = await env.DB.prepare(
    `SELECT id, created_at, filename, mime, size_bytes, total_chars, chunk_count
       FROM documents
      WHERE user_email = ?
      ORDER BY created_at DESC`
  )
    .bind(userEmail)
    .all<{
      id: number;
      created_at: string;
      filename: string;
      mime: string;
      size_bytes: number;
      total_chars: number;
      chunk_count: number;
    }>();
  return json({ user: userEmail, documents: rows.results ?? [] });
}

export async function handleDocumentGet(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const doc = await env.DB.prepare(
    `SELECT id, created_at, filename, mime, size_bytes, total_chars, chunk_count
       FROM documents
      WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first();
  if (!doc) return json({ error: "Not found" }, { status: 404 });

  // Include first ~10 chunks for inspection without dumping the whole doc.
  const chunks = await env.DB.prepare(
    `SELECT chunk_index, text FROM chunks
      WHERE document_id = ? AND user_email = ?
      ORDER BY chunk_index ASC
      LIMIT 10`
  )
    .bind(id, userEmail)
    .all();

  return json({ document: doc, chunk_preview: chunks.results ?? [] });
}

// v0.26.0: a .zip upload is imported durably via the LongRunWorkflow rather
// than synchronously. We stage the archive to R2 (the workflow reads it from
// there, since 10MB can't ride the workflow event payload), kick off the
// workflow, and return its instance id as job_id. The client polls
// GET /api/import/:id for the result. Expansion + per-file ingest happen in
// separate workflow steps, each with a fresh subrequest budget, so large
// archives import without hitting the per-invocation subrequest limit that the
// old synchronous path (v0.25.0) could approach.
export async function handleZipImport(env: Env, userEmail: string, zipBytes: Uint8Array): Promise<Response> {
  // Stage the archive so the workflow can read it back. customMetadata.user_email
  // matches the convention used for every other R2 object.
  const zipKey = `tmp/${crypto.randomUUID()}.zip`;
  try {
    await env.R2.put(zipKey, zipBytes, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { user_email: userEmail },
    });
  } catch (err) {
    return json({ error: `Failed to stage zip: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  const startedAt = new Date().toISOString();
  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: { kind: "zip_import", userEmail, zipKey, startedAtIso: startedAt } satisfies LongRunParams,
    });
    instanceId = instance.id;
  } catch (err) {
    await r2DeleteSafe(env, zipKey);
    return json({ error: `Failed to start import: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  // async:true tells the client to poll /api/import/:id rather than expecting
  // an inline result.
  return json({ zip: true, async: true, job_id: instanceId });
}

// v0.26.0: poll a zip-import workflow. Translates the workflow instance status
// into the same pending/done/failed vocabulary the rest of the UI uses. The
// import summary is only returned to the user who started it (the workflow
// records userEmail in its output), so a guessed instance id can't read another
// user's result.
export async function handleImportStatus(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  let status: { status: string; output?: unknown; error?: unknown };
  try {
    const instance = await env.LONGRUN.get(id);
    status = await instance.status();
  } catch {
    return json({ error: "Unknown import job" }, { status: 404 });
  }

  if (status.status === "complete") {
    const summary = (status.output ?? {}) as Partial<ZipImportSummary>;
    if (summary.userEmail !== userEmail) {
      return json({ error: "Unknown import job" }, { status: 404 });
    }
    return json({
      status: "done",
      imported_count: summary.imported_count ?? 0,
      total_chunks: summary.total_chunks ?? 0,
      imported: summary.imported ?? [],
      skipped: summary.skipped ?? [],
    });
  }

  if (status.status === "errored" || status.status === "terminated") {
    const msg = typeof status.error === "string" ? status.error : JSON.stringify(status.error ?? "import failed");
    return json({ status: "failed", error: msg });
  }

  // queued / running / waiting / paused / unknown -> still in progress.
  return json({ status: "pending" });
}

export async function handleDocumentUpload(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Accept JSON { filename, mime, data: base64 } - matches the existing
  // attachment-upload convention used by the chat path.
  let body: { filename?: string; mime?: string; data?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const filename = body.filename || "untitled.txt";
  const mime = body.mime || "text/plain";
  // No file-type allowlist: any file is accepted. extractChunks routes by
  // format and falls back to UTF-8 text for unknown types, rejecting only
  // bytes that don't decode to usable text. A .zip is expanded (v0.25.0).
  if (!body.data) {
    return json({ error: "Missing file data" }, { status: 400 });
  }

  // Decode base64 data URL or raw base64.
  let bytes: Uint8Array;
  try {
    const parsed = body.data.startsWith("data:") ? parseDataUrl(body.data) : null;
    bytes = parsed ? base64ToBytes(parsed.base64) : base64ToBytes(body.data);
  } catch (err) {
    return json({ error: `Bad file data: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (bytes.length > DOC_MAX_BYTES) {
    return json({ error: `File too large (${bytes.length} bytes, max ${DOC_MAX_BYTES})` }, { status: 413 });
  }

  // v0.25.0: a zip is expanded and each inner file ingested separately.
  if (isZip(bytes)) {
    return handleZipImport(env, userEmail, bytes);
  }

  const r = await ingestDocument(env, userEmail, filename, mime, bytes);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({
    id: r.id,
    created_at: r.created_at,
    filename: r.filename,
    mime: r.mime,
    size_bytes: r.size_bytes,
    total_chars: r.total_chars,
    chunk_count: r.chunk_count,
  });
}

export async function handleDocumentDelete(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  const doc = await env.DB.prepare(
    `SELECT r2_key FROM documents WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{ r2_key: string }>();
  if (!doc) return json({ error: "Not found" }, { status: 404 });

  // Collect vector IDs first so we can clean them out of Vectorize.
  const chunkRows = await env.DB.prepare(
    `SELECT vector_id FROM chunks WHERE document_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .all<{ vector_id: string }>();

  const vectorIds = (chunkRows.results ?? []).map((r) => r.vector_id);
  if (vectorIds.length) {
    try { await env.VEC.deleteByIds(vectorIds); } catch { /* best effort */ }
  }

  // Cascade delete in D1 (no real FK enforcement, so explicit) and R2.
  // v0.20.1: also clean up project_documents memberships so deleting a doc
  // that's attached to projects doesn't leave orphan membership rows.
  // v0.20.3: also clean up project_messages (raw Discord rows) for the doc.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chunks            WHERE document_id = ? AND user_email = ?`).bind(id, userEmail),
    env.DB.prepare(`DELETE FROM project_documents WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM project_messages  WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM documents         WHERE id          = ? AND user_email = ?`).bind(id, userEmail),
  ]);
  await r2DeleteSafe(env, doc.r2_key);

  return json({ deleted: id, vectors_removed: vectorIds.length });
}

