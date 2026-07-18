// Conversation routes: list conversations (grouped by conversation_id), fetch a
// full transcript, delete a conversation (cascading R2 artifacts across all its
// turns), and move a conversation to/from a project. Scoped to the caller.

import type { Env } from "../env";
import { json, getUserEmail, r2DeleteSafe, safeParseJson } from "./shared";
import type { PersistedAttachment, OutputArtifact, RetrievedItem } from "./shared";

// ---------- Multi-turn conversations ----------
//
// A conversation is a set of chat rows sharing the same conversation_id,
// ordered by turn_index. Old single-turn chats with NULL conversation_id
// were backfilled in the migration to 'legacy-<id>' so they still appear
// in the list. Non-chat rows (image/tts/etc) get 'single-<id>' assigned
// at persistChat time and show as single-turn entries.
//
// handleConversationList returns one row per distinct conversation_id with
// a summary: turn count, first prompt, latest model, last activity. Used
// by the sidebar as the replacement for the per-row history list.
//
// handleConversationGet returns all rows of a conversation in turn order.
// Used when the user clicks a conversation to view the full transcript.

export async function handleConversationList(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Group by conversation_id. For each, give:
  //   - turn_count, first/last timestamps
  //   - the first user_input as a preview
  //   - the model used in the latest turn
  //   - whether any turn has a non-null output_artifact (for the icon)
  //   - the model_type of the first turn (chat/image/tts/video/music/stt)
  //   - v0.20.2: project_id from the conversation's first turn (the sidebar
  //     shows a project chip when this is set). project_id is a per-row
  //     column but conversations are expected to have a uniform value
  //     across turns (handleConversationMoveToProject updates all turns
  //     atomically). Subqueries match the existing pattern for first_input.
  const rows = await env.DB.prepare(
    `SELECT
        c.conversation_id,
        COUNT(*) AS turn_count,
        MIN(c.created_at) AS first_created_at,
        MAX(c.created_at) AS last_created_at,
        (SELECT user_input FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS first_input,
        (SELECT model FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index DESC LIMIT 1) AS latest_model,
        (SELECT model_type FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS first_model_type,
        (SELECT project_id FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS project_id,
        SUM(CASE WHEN output_artifact IS NOT NULL THEN 1 ELSE 0 END) AS artifact_count
      FROM chats c
      WHERE c.user_email = ?
      GROUP BY c.conversation_id
      ORDER BY last_created_at DESC
      LIMIT 200`
  )
    .bind(userEmail)
    .all<{
      conversation_id: string;
      turn_count: number;
      first_created_at: string;
      last_created_at: string;
      first_input: string;
      latest_model: string;
      first_model_type: string;
      project_id: number | null;
      artifact_count: number;
    }>();
  return json({ user: userEmail, conversations: rows.results ?? [] });
}

export async function handleConversationGet(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM chats
      WHERE conversation_id = ? AND user_email = ?
      ORDER BY turn_index ASC, created_at ASC`
  )
    .bind(id, userEmail)
    .all<{
      attachments: string | null;
      output_artifact: string | null;
      retrieved_context: string | null;
    }>();

  if ((rows.results ?? []).length === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  // Parse the JSON columns on each turn so the frontend doesn't have to.
  const turns = (rows.results ?? []).map((row) => ({
    ...row,
    attachments: row.attachments ? safeParseJson<PersistedAttachment[]>(row.attachments) : null,
    output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedItem[]>(row.retrieved_context) : null,
  }));

  return json({ conversation_id: id, turns });
}

export async function handleConversationDelete(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Pull all R2 keys across all turns before deleting D1 rows.
  const rows = await env.DB.prepare(
    `SELECT attachments, output_artifact FROM chats
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .all<{ attachments: string | null; output_artifact: string | null }>();

  const results = rows.results ?? [];
  if (results.length === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const keysToDelete: string[] = [];
  for (const row of results) {
    if (row.attachments) {
      const atts = safeParseJson<PersistedAttachment[]>(row.attachments) ?? [];
      for (const a of atts) {
        if (a.type === "image") keysToDelete.push(a.key);
        else if (a.type === "video_frames") keysToDelete.push(...(a.keys ?? []));
        else if (a.type === "video_full") keysToDelete.push(a.key);
      }
    }
    if (row.output_artifact) {
      const oa = safeParseJson<OutputArtifact>(row.output_artifact);
      if (oa?.key) keysToDelete.push(oa.key);
    }
  }

  await env.DB.prepare(
    `DELETE FROM chats WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();

  for (const k of keysToDelete) {
    await r2DeleteSafe(env, k);
  }

  return json({ deleted: id, turns_removed: results.length, artifacts_removed: keysToDelete.length });
}

// v0.20.2: move a conversation to a project (or clear its project assignment).
// Body: { project_id: number | null }. When project_id is a number, the
// project must exist and belong to the same user. When null, the assignment
// is cleared on all turns.
//
// All turns in the conversation are updated atomically. The conversation_id
// is the existing key for ownership (chats.user_email + conversation_id).
export async function handleConversationMoveToProject(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  let body: { project_id?: number | null };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const newProjectId = body.project_id ?? null;
  if (newProjectId !== null) {
    if (!Number.isInteger(newProjectId) || newProjectId <= 0) {
      return json({ error: "project_id must be a positive integer or null" }, { status: 400 });
    }
    // Confirm the target project exists and belongs to this user.
    const proj = await env.DB.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_email = ?`
    )
      .bind(newProjectId, userEmail)
      .first();
    if (!proj) return json({ error: "Project not found" }, { status: 404 });
  }

  // Confirm the conversation exists and belongs to this user before
  // updating, otherwise we silently no-op on stale ids.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chats
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(conversationId, userEmail)
    .first<{ n: number }>();
  if (!existing || existing.n === 0) {
    return json({ error: "Conversation not found" }, { status: 404 });
  }

  const result = await env.DB.prepare(
    `UPDATE chats SET project_id = ?
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(newProjectId, conversationId, userEmail)
    .run();

  return json({
    conversation_id: conversationId,
    project_id: newProjectId,
    rows_updated: result.meta?.changes ?? 0,
  });
}

