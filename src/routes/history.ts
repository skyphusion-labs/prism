// History routes: list the caller chat rows, fetch one, delete one (cascading
// its R2 artifacts). Rows are scoped to the caller user_email.

import type { Env } from "../env";
import { json, getUserEmail, r2DeleteSafe, safeParseJson } from "./shared";
import type { PersistedAttachment, OutputArtifact, RetrievedItem } from "./shared";

// ---------- History ----------

export async function handleHistoryList(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  const rows = await env.DB.prepare(
    `SELECT id, created_at, model, model_type, system_prompt, user_input, output,
            tokens_in, tokens_out, latency_ms, status,
            CASE WHEN attachments     IS NOT NULL THEN 1 ELSE 0 END AS has_attachments,
            CASE WHEN output_artifact IS NOT NULL THEN 1 ELSE 0 END AS has_output_artifact
       FROM chats
      WHERE user_email = ?
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(userEmail, limit)
    .all();

  return json({ user: userEmail, chats: rows.results ?? [] });
}

export async function handleHistoryGet(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const row = await env.DB.prepare(
    `SELECT * FROM chats WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{ attachments: string | null; output_artifact: string | null; retrieved_context: string | null }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  return json({
    ...row,
    attachments: row.attachments ? safeParseJson<PersistedAttachment[]>(row.attachments) : null,
    output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedItem[]>(row.retrieved_context) : null,
  });
}

export async function handleHistoryDelete(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Pull keys first so we can clean up R2.
  const row = await env.DB.prepare(
    `SELECT attachments, output_artifact FROM chats WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{ attachments: string | null; output_artifact: string | null }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  const keysToDelete: string[] = [];
  if (row.attachments) {
    const atts = safeParseJson<PersistedAttachment[]>(row.attachments) ?? [];
    for (const a of atts) {
      if (a.type === "image") keysToDelete.push(a.key);
      else if (a.type === "video_frames") keysToDelete.push(...(a.keys ?? []));
      else if (a.type === "video_full") keysToDelete.push(a.key);
      // audio has no R2 reference
    }
  }
  if (row.output_artifact) {
    const oa = safeParseJson<OutputArtifact>(row.output_artifact);
    if (oa?.key) keysToDelete.push(oa.key);
  }

  // Delete from D1 first; if it succeeds, clean R2. (If R2 cleanup fails the
  // row is already gone, so worst case we have orphaned objects, which is
  // fine for occasional manual cleanup.)
  const result = await env.DB.prepare(
    `DELETE FROM chats WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();
  if (!result.success || (result.meta?.changes ?? 0) === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  for (const k of keysToDelete) await r2DeleteSafe(env, k);

  return json({ deleted: id, r2_keys_deleted: keysToDelete.length });
}

