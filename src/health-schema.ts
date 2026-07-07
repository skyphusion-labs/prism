// Required D1 tables for a healthy skyphusion-llm deployment (v0.164.3).
// /health/deep probes these so schema drift (code deployed, migration missed)
// surfaces in monitoring instead of as opaque HTTP 500s on /api/models.

export const REQUIRED_D1_TABLES = [
  "chats",
  "documents",
  "chunks",
  "projects",
  "project_documents",
  "project_messages",
  "user_prefs",
] as const;

export async function probeD1Schema(db: D1Database): Promise<{ ok: boolean; missing: string[] }> {
  const placeholders = REQUIRED_D1_TABLES.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
  )
    .bind(...REQUIRED_D1_TABLES)
    .all<{ name: string }>();
  const present = new Set((rows.results ?? []).map((r) => r.name));
  const missing = REQUIRED_D1_TABLES.filter((t) => !present.has(t));
  return { ok: missing.length === 0, missing: [...missing] };
}
