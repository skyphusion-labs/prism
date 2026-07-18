// Deep health check (/health/deep): exercises D1, the D1 schema, R2, Vectorize,
// and confirms AI gateway configuration, returning 503 if any check fails. The
// cheap liveness /health probe stays inline in index.ts.

import type { Env } from "../env";
import { probeD1Schema } from "../health-schema";
import { json } from "./shared";

// ---------- Health checks ----------
//
// /health is a liveness probe: no binding access, always 200. Use for
// frequent (60s) uptime polling.
//
// /health/deep exercises each external dependency once. Each check is timed
// independently; the response body includes per-check ok/latency/error so
// a partial outage is visible even though the overall HTTP status is 503.
// Use for slower (5min) polling.
//
// Both endpoints sit behind Cloudflare Access. For Kuma to reach them you
// need either an Access service token (recommended) or a bypass policy on
// /health* in the Access app config.

export interface HealthCheckResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export async function handleHealthDeep(env: Env): Promise<Response> {
  const checks: Record<string, HealthCheckResult> = {};

  // D1: SELECT 1 round-trip. Verifies the binding works and the database
  // is reachable. Doesn't touch any user data.
  {
    const t0 = Date.now();
    try {
      await env.DB.prepare(`SELECT 1 AS ok`).first();
      checks.d1 = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.d1 = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // D1 schema: required tables for the deployed worker (v0.164.3). Catches
  // schema drift when code ships before a migration runs (e.g. missing user_prefs).
  {
    const t0 = Date.now();
    try {
      const schema = await probeD1Schema(env.DB);
      checks.d1_schema = schema.ok
        ? { ok: true, latency_ms: Date.now() - t0 }
        : { ok: false, latency_ms: Date.now() - t0, error: `missing tables: ${schema.missing.join(", ")}` };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.d1_schema = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // R2: HEAD on a key that doesn't exist. Returns null on a working binding
  // (no error). Validates auth and bucket reachability without creating or
  // reading user data.
  {
    const t0 = Date.now();
    try {
      await env.R2.head("__healthcheck_nonexistent_key__");
      checks.r2 = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.r2 = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // Vectorize: describe() returns index metadata. Cheap, no vector ops.
  {
    const t0 = Date.now();
    try {
      await env.VEC.describe();
      checks.vectorize = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.vectorize = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // AI binding: confirm worker-level gateway config, or note per-user mode.
  // We deliberately do NOT run an actual model here; even the cheapest model
  // call burns neurons and a per-minute health probe would add up.
  {
    const t0 = Date.now();
    if (env.GATEWAY_ID?.trim()) {
      checks.ai_config = { ok: true, latency_ms: Date.now() - t0 };
    } else {
      // Public demo: users supply gateway slug + token via /api/prefs.
      checks.ai_config = { ok: true, latency_ms: Date.now() - t0 };
    }
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return json(
    { ok: allOk, ts: Date.now(), checks },
    { status: allOk ? 200 : 503 }
  );
}

