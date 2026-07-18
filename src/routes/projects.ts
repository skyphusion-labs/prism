// Project routes: CRUD, document membership add/remove, and DiscordChatExporter
// import into a project. Also owns resolveProjectForChat (the per-project
// system-prompt fallback + RAG scope resolution) used by the chat routes.

import type { Env } from "../env";
import { parseDataUrl, base64ToBytes } from "../utils";
import { parseDiscordExport, chunkDiscordMessages } from "../discord";
import { json, getUserEmail, r2Put, r2DeleteSafe } from "./shared";
import type { ChatRequest } from "./shared";
import { embedBatch, DOC_MAX_BYTES, EMBED_BATCH_SIZE } from "./rag";

// v0.20.0: project + project_documents join. A project groups documents
// (and in v0.20.1, conversations) under a shared system_prompt and
// retrieval scope. Many-to-many membership via project_documents.
export interface ProjectRow {
  id: number;
  user_email: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Projects (v0.20.0) ----------
//
// Projects group documents (and in v0.20.1 onward, conversations) under a
// shared system_prompt and retrieval scope. v0.20.0 endpoints:
//
//   GET    /api/projects                              list user's projects
//   POST   /api/projects                              create project
//   GET    /api/projects/:id                          get project + members
//   PATCH  /api/projects/:id                          rename / update prompt / desc
//   DELETE /api/projects/:id                          delete (cascades to memberships)
//   POST   /api/projects/:pid/documents/:did          add document to project
//   DELETE /api/projects/:pid/documents/:did          remove document from project
//   GET    /api/documents?project_id=N                list docs in project
//
// All endpoints scope by user_email; cross-user reads return 404,
// cross-user writes (e.g. adding another user's doc to your project) are
// rejected with 400 before touching the DB.
//
// Per-project system prompt fallback (handleChat / handleChatStream):
// when a chat request includes project_id but no per-turn system_prompt,
// the project's system_prompt is used as default. A per-turn system_prompt
// always overrides; empty-string system_prompt counts as "set to empty"
// and disables the fallback (intentional - lets users explicitly clear).
//
// Per-project RAG scoping (retrieveContext): when a chat request includes
// project_id, retrieval joins project_documents and excludes chunks from
// documents not in that project's membership set. No project_id means
// "all user's docs" (backward compat).

// Generate a URL-safe slug from a display name. Strips non-alphanumeric
// characters, collapses runs of whitespace and dashes, lowercases, trims.
// Empty input or all-punctuation input falls back to "project".
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")  // drop punctuation/diacritics
    .trim()
    .replace(/[\s-]+/g, "-")          // collapse whitespace runs to single dash
    .replace(/^-+|-+$/g, "");         // trim leading/trailing dashes
  return s || "project";
}

// Find an unused slug for the user. If `base` is unused, returns base.
// Otherwise appends -2, -3, ... until free. Bounded at 200 attempts;
// beyond that we throw, which would indicate a degenerate slug or a
// pathological state.
export async function findFreeSlug(env: Env, userEmail: string, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(
      `SELECT id FROM projects WHERE user_email = ? AND slug = ? LIMIT 1`
    )
      .bind(userEmail, candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate slug after 200 attempts (base='${base}')`);
}

// Shared helper used by runChat + runChatStream. Resolves the chat's
// project_id (if any), looks up the project row scoped to the user, and
// computes the effective system prompt with project-fallback semantics.
//
// Semantics:
//   - body.project_id is undefined or not a positive integer: no project.
//   - body.project_id points to a project not owned by this user: treated
//     same as missing (returns project=null, no fallback). Logged.
//   - body.project_id points to a deleted/unknown project: same as above.
//
//   - Per-turn body.system_prompt non-empty (after trim) wins outright;
//     the project's system_prompt is ignored.
//   - Per-turn body.system_prompt is undefined or empty/whitespace AND a
//     project is resolved AND that project has a non-null system_prompt:
//     use the project's prompt.
//   - Otherwise: no effective prompt (undefined).
//
// The resolved project_id is also returned for retrieveContext scoping.
export async function resolveProjectForChat(
  env: Env,
  userEmail: string,
  body: ChatRequest,
): Promise<{ project: ProjectRow | null; resolvedSystemPrompt: string | undefined; scopedProjectId: number | undefined }> {
  let project: ProjectRow | null = null;
  let scopedProjectId: number | undefined;

  if (body.project_id !== undefined && Number.isInteger(body.project_id) && body.project_id > 0) {
    project = await env.DB.prepare(
      `SELECT id, user_email, name, slug, description, system_prompt, created_at, updated_at
         FROM projects WHERE id = ? AND user_email = ?`
    )
      .bind(body.project_id, userEmail)
      .first<ProjectRow>();
    if (!project) {
      console.warn(
        `Chat referenced unknown project_id=${body.project_id} for user_email='${userEmail}'; ` +
        `falling back to no-project semantics (no system prompt fallback, no retrieval scoping).`
      );
    } else {
      scopedProjectId = project.id;
    }
  }

  const reqPrompt = body.system_prompt;
  const hasReqPrompt = reqPrompt !== undefined && reqPrompt.trim() !== "";
  const resolvedSystemPrompt = hasReqPrompt
    ? reqPrompt
    : (project?.system_prompt ?? undefined);

  return { project, resolvedSystemPrompt, scopedProjectId };
}

export async function handleProjectList(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  // LEFT JOIN to count document memberships per project. COUNT(pd.document_id)
  // returns 0 for projects with no members (because of LEFT JOIN), rather
  // than 1 which COUNT(*) would return.
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.description, p.system_prompt,
            p.created_at, p.updated_at,
            COUNT(pd.document_id) AS document_count
       FROM projects p
       LEFT JOIN project_documents pd ON pd.project_id = p.id
      WHERE p.user_email = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC`
  )
    .bind(userEmail)
    .all<{
      id: number; name: string; slug: string; description: string | null;
      system_prompt: string | null; created_at: string; updated_at: string;
      document_count: number;
    }>();
  return json({ user: userEmail, projects: rows.results ?? [] });
}

export async function handleProjectGet(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const proj = await env.DB.prepare(
    `SELECT id, name, slug, description, system_prompt, created_at, updated_at
       FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<ProjectRow>();
  if (!proj) return json({ error: "Not found" }, { status: 404 });

  // Include the project's documents (id, filename, chunk_count) so the
  // detail view can render them without a second fetch.
  const docs = await env.DB.prepare(
    `SELECT d.id, d.filename, d.mime, d.size_bytes, d.chunk_count, d.created_at,
            pd.added_at
       FROM project_documents pd
       JOIN documents d ON d.id = pd.document_id
      WHERE pd.project_id = ? AND d.user_email = ?
      ORDER BY pd.added_at DESC`
  )
    .bind(id, userEmail)
    .all<{
      id: number; filename: string; mime: string; size_bytes: number;
      chunk_count: number; created_at: string; added_at: string;
    }>();

  return json({ project: proj, documents: docs.results ?? [] });
}

export async function handleProjectCreate(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  let body: { name?: string; description?: string; system_prompt?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, { status: 400 });
  if (name.length > 200) return json({ error: "name too long (max 200 chars)" }, { status: 400 });

  const baseSlug = slugify(name);
  const slug = await findFreeSlug(env, userEmail, baseSlug);

  const description = (body.description ?? "").trim() || null;
  const systemPrompt = (body.system_prompt ?? "").trim() || null;

  const result = await env.DB.prepare(
    `INSERT INTO projects (user_email, name, slug, description, system_prompt)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id, name, slug, description, system_prompt, created_at, updated_at`
  )
    .bind(userEmail, name, slug, description, systemPrompt)
    .first<ProjectRow>();

  if (!result) return json({ error: "Insert failed" }, { status: 500 });
  return json({ project: result }, { status: 201 });
}

export async function handleProjectUpdate(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  // Confirm ownership before any write.
  const existing = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first();
  if (!existing) return json({ error: "Not found" }, { status: 404 });

  let body: { name?: string; description?: string | null; system_prompt?: string | null };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Build dynamic UPDATE based on which fields the caller sent. Undefined =
  // "don't touch"; null or empty string = "clear to empty/null". Name has
  // to be a non-empty string if provided.
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return json({ error: "name cannot be empty" }, { status: 400 });
    if (n.length > 200) return json({ error: "name too long (max 200 chars)" }, { status: 400 });
    sets.push("name = ?");
    params.push(n);
  }
  if (body.description !== undefined) {
    const d = (body.description ?? "").toString().trim() || null;
    sets.push("description = ?");
    params.push(d);
  }
  if (body.system_prompt !== undefined) {
    const sp = (body.system_prompt ?? "").toString().trim() || null;
    sets.push("system_prompt = ?");
    params.push(sp);
  }

  if (sets.length === 0) {
    return json({ error: "No updatable fields in body" }, { status: 400 });
  }

  // Slug is intentionally NOT updated on rename. Keeps URLs/storage keys
  // stable. If renames need new slugs, that's a separate explicit op.
  sets.push("updated_at = datetime('now')");
  params.push(id, userEmail);

  await env.DB.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND user_email = ?`
  )
    .bind(...params)
    .run();

  const updated = await env.DB.prepare(
    `SELECT id, name, slug, description, system_prompt, created_at, updated_at
       FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<ProjectRow>();
  return json({ project: updated });
}

export async function handleProjectDelete(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const existing = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first();
  if (!existing) return json({ error: "Not found" }, { status: 404 });

  // Cascade: delete memberships first, then the project itself. Documents
  // belonging to the project STAY (they may be in other projects, and even
  // if not, the user uploaded them and may want to keep them outside
  // project organization). v0.20.3: also clear project_messages scoped to
  // this project (raw Discord rows; the documents and their chunks stay).
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM project_documents WHERE project_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM project_messages  WHERE project_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM projects          WHERE id = ? AND user_email = ?`).bind(id, userEmail),
  ]);
  return json({ deleted: id });
}

export async function handleProjectDocAdd(request: Request, env: Env, projectId: number, docId: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  // Confirm both project and document belong to the user. Cross-user
  // attachment is rejected here.
  const proj = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(projectId, userEmail)
    .first();
  if (!proj) return json({ error: "Project not found" }, { status: 404 });

  const doc = await env.DB.prepare(
    `SELECT id FROM documents WHERE id = ? AND user_email = ?`
  )
    .bind(docId, userEmail)
    .first();
  if (!doc) return json({ error: "Document not found" }, { status: 404 });

  // INSERT OR IGNORE: idempotent membership. Reattaching a doc that's
  // already a member returns 200 without an error (added_at stays at the
  // original value).
  await env.DB.prepare(
    `INSERT OR IGNORE INTO project_documents (project_id, document_id) VALUES (?, ?)`
  )
    .bind(projectId, docId)
    .run();
  return json({ project_id: projectId, document_id: docId, added: true });
}

export async function handleProjectDocRemove(request: Request, env: Env, projectId: number, docId: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const proj = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(projectId, userEmail)
    .first();
  if (!proj) return json({ error: "Project not found" }, { status: 404 });

  await env.DB.prepare(
    `DELETE FROM project_documents WHERE project_id = ? AND document_id = ?`
  )
    .bind(projectId, docId)
    .run();
  return json({ project_id: projectId, document_id: docId, removed: true });
}

// v0.20.3: import a DiscordChatExporter JSON export into a project.
//
// POST /api/projects/:id/import-discord
// Body: { filename?: string, data: base64, options?: { gapMinutes, includeBots } }
//
// Pipeline (mirrors handleDocumentUpload, but for Discord exports):
//   1. validate project ownership
//   2. decode + size-check the export bytes
//   3. parse DCE JSON -> normalized messages (parseDiscordExport)
//   4. conversation-aware chunk (chunkDiscordMessages)
//   5. store export bytes in R2
//   6. insert a documents row for the export file
//   7. attach the document to the project (project_documents)
//   8. persist raw messages to project_messages (for future re-chunking)
//   9. embed chunks, upsert to Vectorize, insert chunk rows with the
//      channel/authors/time metadata columns
//
// The chunk embed/store loop is intentionally a near-duplicate of the one in
// handleDocumentUpload rather than a shared helper: the document path is the
// higher-traffic code and has no integration tests, so refactoring it to
// share code carries regression risk disproportionate to ~30 saved lines.
// Consolidation is a candidate for a later cleanup release once integration
// tests exist.
export async function handleDiscordImport(request: Request, env: Env, projectId: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  const proj = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(projectId, userEmail)
    .first();
  if (!proj) return json({ error: "Project not found" }, { status: 404 });

  let body: { filename?: string; data?: string; options?: { gapMinutes?: number; includeBots?: boolean } };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.data) {
    return json({ error: "Missing export data" }, { status: 400 });
  }

  const filename = body.filename || "discord-export.json";

  // Decode base64 (data URL or raw).
  let bytes: Uint8Array;
  try {
    const parsed = body.data.startsWith("data:") ? parseDataUrl(body.data) : null;
    bytes = parsed ? base64ToBytes(parsed.base64) : base64ToBytes(body.data);
  } catch (err) {
    return json({ error: `Bad export data: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (bytes.length > DOC_MAX_BYTES) {
    return json({
      error: `Export too large (${bytes.length} bytes, max ${DOC_MAX_BYTES}). Split the export by date range or channel, or wait for presigned upload (v0.20.4).`,
    }, { status: 413 });
  }

  // Parse the JSON export.
  let exportJson: unknown;
  try {
    exportJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return json({ error: `Export is not valid JSON: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseDiscordExport(exportJson);
  } catch (err) {
    return json({ error: `Not a recognized DiscordChatExporter export: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (parsed.messages.length === 0) {
    return json({
      error: "No usable messages in the export (all were system notifications or empty). Nothing to import.",
    }, { status: 400 });
  }

  const chunks = chunkDiscordMessages(parsed.messages, {
    gapMinutes: body.options?.gapMinutes,
    includeBots: body.options?.includeBots,
  });
  if (chunks.length === 0) {
    return json({ error: "Parsing produced messages but chunking produced none (check includeBots option)." }, { status: 400 });
  }

  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  const mime = "application/json";
  const r2Key = await r2Put(env, "in", mime, bytes, userEmail);

  // Insert the documents row for the export file.
  const docInsert = await env.DB.prepare(
    `INSERT INTO documents
       (user_email, filename, mime, r2_key, size_bytes, total_chars, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(userEmail, filename, mime, r2Key, bytes.length, totalChars, chunks.length)
    .first<{ id: number; created_at: string }>();
  if (!docInsert) {
    await r2DeleteSafe(env, r2Key);
    return json({ error: "Failed to insert document row" }, { status: 500 });
  }
  const docId = docInsert.id;

  // Attach the export document to the project so project-scoped retrieval
  // includes it immediately.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO project_documents (project_id, document_id) VALUES (?, ?)`
  )
    .bind(projectId, docId)
    .run();

  // Persist raw messages for future re-chunking. Batched in groups to stay
  // within D1 statement limits.
  const PM_BATCH = 50;
  for (let i = 0; i < parsed.messages.length; i += PM_BATCH) {
    const slice = parsed.messages.slice(i, i + PM_BATCH);
    const stmts = slice.map((m) =>
      env.DB.prepare(
        `INSERT INTO project_messages
           (project_id, document_id, user_email, message_id, channel, author, author_id, is_bot, sent_at, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(projectId, docId, userEmail, m.messageId, m.channel, m.author, m.authorId, m.isBot ? 1 : 0, m.sentAt, m.content)
    );
    await env.DB.batch(stmts);
  }

  // Embed chunks and upsert to Vectorize. vector_id scheme matches documents:
  // `${userEmail}:${docId}:${chunkIndex}`.
  const vectorIdsWritten: string[] = [];
  const chunkRowsToInsert: {
    chunk_index: number;
    text: string;
    vector_id: string;
    channel: string;
    authors: string;
    sent_at_start: string;
    sent_at_end: string;
  }[] = [];

  try {
    for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(env, userEmail, batch.map((c) => c.text));
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding batch returned ${vectors.length} vectors for ${batch.length} texts`);
      }
      const payload = batch.map((c, i) => {
        const idx = b + i;
        const vid = `${userEmail}:${docId}:${idx}`;
        chunkRowsToInsert.push({
          chunk_index: idx,
          text: c.text,
          vector_id: vid,
          channel: c.channel,
          authors: c.authors.join(", "),
          sent_at_start: c.sentAtStart,
          sent_at_end: c.sentAtEnd,
        });
        vectorIdsWritten.push(vid);
        return {
          id: vid,
          values: vectors[i],
          metadata: {
            user_email: userEmail,
            document_id: docId,
            chunk_index: idx,
            channel: c.channel,
          },
        };
      });
      await env.VEC.upsert(payload);
    }
  } catch (err) {
    // Rollback partial state.
    if (vectorIdsWritten.length) {
      try { await env.VEC.deleteByIds(vectorIdsWritten); } catch { /* swallow */ }
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM project_messages  WHERE document_id = ?`).bind(docId),
      env.DB.prepare(`DELETE FROM project_documents WHERE document_id = ?`).bind(docId),
      env.DB.prepare(`DELETE FROM documents         WHERE id = ?`).bind(docId),
    ]);
    await r2DeleteSafe(env, r2Key);
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Embedding failed: ${m}` }, { status: 502 });
  }

  // Insert chunk rows with the Discord metadata columns. page/sheet stay NULL.
  if (chunkRowsToInsert.length) {
    for (let i = 0; i < chunkRowsToInsert.length; i += PM_BATCH) {
      const slice = chunkRowsToInsert.slice(i, i + PM_BATCH);
      const stmts = slice.map((c) =>
        env.DB.prepare(
          `INSERT INTO chunks
             (document_id, user_email, chunk_index, text, vector_id, channel, authors, sent_at_start, sent_at_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(docId, userEmail, c.chunk_index, c.text, c.vector_id, c.channel, c.authors, c.sent_at_start, c.sent_at_end)
      );
      await env.DB.batch(stmts);
    }
  }

  return json({
    document_id: docId,
    created_at: docInsert.created_at,
    project_id: projectId,
    filename,
    guild: parsed.guild,
    channel: parsed.channel,
    raw_message_count: parsed.rawCount,
    imported_message_count: parsed.parsedCount,
    chunk_count: chunks.length,
  });
}

