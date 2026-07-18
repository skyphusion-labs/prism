// LongRunWorkflow: Cloudflare Workflow for durable Unified Billing video/music
// generation and bulk .zip RAG import. Re-exported from index.ts (wrangler
// resolves the workflow class_name against the main entry). The gen path holds
// the blocking env.AI.run call alive across step boundaries; the zip path
// ingests one file per step (via ./rag ingestDocument) for a fresh subrequest
// budget each.

import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env";
import { aiRun, type AiContext } from "../ai-binding";
import { loadGatewayCredentials, GATEWAY_NOT_CONFIGURED_MSG } from "../gateway-credentials";
import { buildGenParams } from "../longrun-params";
import { unzip } from "../zip";
import { r2Put, r2KeyToDataUri, r2DeleteSafe } from "./shared";
import type { OutputArtifact } from "./shared";
import {
  ingestDocument,
  mimeFromName,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  ZIP_MAX_FILE_BYTES,
} from "./rag";

// ---------- LongRunWorkflow (v0.12.0) ----------
//
// Cloudflare Workflow that handles Unified Billing video and music generation.
// Both surfaces (runVideo Unified path, runMusic) hand off to this class via
// env.LONGRUN.create({ params }). The workflow is responsible for:
//   1. Invoking env.AI.run (blocking call, 30s-3min)
//   2. Downloading the resulting artifact from CF's catalog R2 bucket
//   3. Uploading the bytes to our own R2 bucket
//   4. Finalizing the D1 row (status, output_artifact, latency)
//
// Why Workflows rather than ctx.waitUntil:
//   - waitUntil has a ~30s budget after the HTTP response is sent. env.AI.run
//     for Veo/Seedance/Hailuo etc. takes 1-3 minutes, so the task gets
//     cancelled mid-call. That cancellation was the failure mode in v0.11.x.
//   - Workflows have unlimited wall-clock time per step (CPU time still
//     capped, but env.AI.run is I/O-bound).
//   - Each step retries independently with built-in backoff, so a transient
//     R2 upload failure doesn't force re-running the (expensive) gen call.
//
// Step 2 (download + R2 upload) is one combined step because step.do return
// values are capped at 1 MiB; video files are 5-15MB, music 3-5MB - we can't
// pass bytes between steps. So we fold the download and R2 put into a single
// step and return just the small R2 key. The trade-off: if R2 upload fails
// after a successful download, the retry re-downloads the same source URL
// (CF's catalog R2 - cheap and reliable). Acceptable.
//
// Response shapes per https://developers.cloudflare.com/ai/models/:
//   Veo:     { state:"Completed", result:{ video:"..." }, gatewayMetadata }
//   MiniMax: { audio:"..." } (flat) - some normalized providers may wrap in
//            { state, result:{ audio }, gatewayMetadata } so we accept both.
//   Other UB video providers (bytedance/runway/alibaba/pixverse/vidu) are
//   expected to follow the Veo-style wrapper but have NOT been runtime-
//   verified as of v0.12.0. Per-provider param shapes may also differ from
//   the Veo baseline (prompt/duration/aspect_ratio/resolution/generate_audio);
//   errors surface in job_error for iteration.

export type LongRunKind = "video" | "music";

export interface LongRunGenParams extends Record<string, unknown> {
  rowId: number;
  userEmail: string;
  modelId: string;
  prompt: string;
  lyrics?: string;          // music only
  imageUrl?: string;        // image-to-video: a fetchable URL passed through as-is
  imageKey?: string;        // image-to-video: an R2 key resolved to a data: URI in the workflow (uploads + chaining)
  kind: LongRunKind;
  startedAtIso: string;
}

// v0.26.0: durable bulk ZIP import. The uploaded archive is staged to R2
// (`zipKey`) so its bytes never ride the workflow event payload; the workflow
// unzips it and ingests each inner file in its own step. Putting each file in
// a separate step gives each ingest a fresh Worker subrequest budget, which is
// what lets a large archive import without hitting the per-invocation limit
// that the synchronous v0.25.0 path could approach.
export interface ZipImportParams extends Record<string, unknown> {
  kind: "zip_import";
  userEmail: string;
  zipKey: string;
  startedAtIso: string;
}

export type LongRunParams =
  | LongRunGenParams
  | ZipImportParams;

// Returned by the zip-import workflow run() and surfaced via the instance's
// status().output to the polling client. userEmail is included so the status
// endpoint can enforce per-user ownership (a guessed instance id can't read
// another user's import result).
export interface ZipImportSummary {
  userEmail: string;
  imported_count: number;
  total_chunks: number;
  imported: Array<{ name: string; id: number; chunk_count: number }>;
  skipped: Array<{ name: string; reason: string }>;
}

// Shape we expect back from env.AI.run for video and music. Both share the
// same envelope; only the inner field differs (video vs audio).
export interface LongRunResult {
  state?: string;
  result?: { video?: string; audio?: string };
  audio?: string;          // flat shape for minimax/music-2.6
  gatewayMetadata?: { keySource?: string };
}

export class LongRunWorkflow extends WorkflowEntrypoint<Env, LongRunParams> {
  async run(event: WorkflowEvent<LongRunParams>, step: WorkflowStep): Promise<unknown> {
    if (event.payload.kind === "zip_import") {
      return this.runZipImport(event.payload, step);
    }
    return this.runGen(event.payload, step);
  }

  // v0.26.0: bulk ZIP import. Step 1 unzips the staged archive and stages each
  // inner file to a temp R2 object (returning only the small name+key list, so
  // we stay under the 1 MiB step-return cap and never pass bytes between
  // steps). Each subsequent step ingests one file with a fresh subrequest
  // budget. A failed ingest becomes a skip, not a workflow failure. A final
  // step deletes the temp objects and the staged zip.
  async runZipImport(p: ZipImportParams, step: WorkflowStep): Promise<ZipImportSummary> {
    const { userEmail, zipKey } = p;

    const { staged, skipped: unzipSkipped } = await step.do(
      "unzip-and-stage",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async (): Promise<{ staged: Array<{ name: string; key: string }>; skipped: Array<{ name: string; reason: string }> }> => {
        const obj = await this.env.R2.get(zipKey);
        if (!obj) throw new Error("staged zip not found in R2");
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const { entries, skipped } = await unzip(bytes, {
          maxEntries: ZIP_MAX_ENTRIES,
          maxTotalBytes: ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
          maxFileBytes: ZIP_MAX_FILE_BYTES,
        });
        const out: Array<{ name: string; key: string }> = [];
        for (const e of entries) {
          const key = `tmp/${crypto.randomUUID()}`;
          await this.env.R2.put(key, e.bytes, { customMetadata: { user_email: userEmail } });
          out.push({ name: e.name, key });
        }
        return { staged: out, skipped };
      }
    );

    const imported: ZipImportSummary["imported"] = [];
    const skipped: ZipImportSummary["skipped"] = [...unzipSkipped];

    // One step per file: each gets its own subrequest budget. ingestDocument
    // swallows its own errors into an ok:false result (after rolling back its
    // partial writes), so an unreadable file does not abort the import.
    for (let i = 0; i < staged.length; i++) {
      const item = staged[i];
      const res = await step.do(
        `ingest-${i}`,
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<{ ok: true; name: string; id: number; chunk_count: number } | { ok: false; name: string; reason: string }> => {
          const obj = await this.env.R2.get(item.key);
          if (!obj) return { ok: false, name: item.name, reason: "staged file missing" };
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const r = await ingestDocument(this.env, userEmail, item.name, mimeFromName(item.name), bytes);
          return r.ok
            ? { ok: true, name: item.name, id: r.id, chunk_count: r.chunk_count }
            : { ok: false, name: item.name, reason: r.error };
        }
      );
      if (res.ok) imported.push({ name: res.name, id: res.id, chunk_count: res.chunk_count });
      else skipped.push({ name: res.name, reason: res.reason });
    }

    // Cleanup: drop the temp staged files and the staged zip. Best-effort; a
    // leaked temp object under tmp/ is harmless and can be swept by an R2
    // lifecycle rule. Done after all ingests so a per-file step retry can still
    // re-read its staged object.
    await step.do(
      "cleanup",
      { retries: { limit: 1, delay: "5 seconds", backoff: "linear" } },
      async (): Promise<void> => {
        for (const item of staged) await r2DeleteSafe(this.env, item.key);
        await r2DeleteSafe(this.env, zipKey);
      }
    );

    return {
      userEmail,
      imported_count: imported.length,
      total_chunks: imported.reduce((s, d) => s + d.chunk_count, 0),
      imported,
      skipped,
    };
  }

  async runGen(payload: LongRunGenParams, step: WorkflowStep): Promise<void> {
    const { rowId, userEmail, modelId, prompt, lyrics, imageUrl, imageKey, kind, startedAtIso } = payload;

    // Best-effort row-fail helper. Used in the outer catch to surface
    // workflow-level failures to the polling client. Failures inside this
    // helper are intentionally swallowed - if D1 is down, there's nothing
    // we can do from a background workflow anyway.
    const failRow = async (msg: string): Promise<void> => {
      try {
        await this.env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
          .bind(msg.slice(0, 1000), rowId)
          .run();
      } catch { /* swallow */ }
    };

    try {
      // Step 1: invoke the model. Long-running blocking call.
      //
      // Retry policy: ONE retry only. Each attempt costs Unified Billing
      // credits; if it fails twice with a 30s spacing, the third attempt is
      // unlikely to help and we'd rather surface the error to the user.
      const artifactUrl = await step.do(
        "invoke-model",
        { retries: { limit: 1, delay: "30 seconds", backoff: "linear" } },
        async (): Promise<string> => {
          // Resolve the source image for image-to-video: an R2 key (upload or
          // chained nano-banana output) becomes a data: URI here, inside the
          // step, so the big base64 never rides the Workflow event payload.
          // A plain URL passes straight through. Resolution happens in-step so
          // a transient R2 read is covered by the step's retry.
          const resolvedImage = imageKey
            ? await r2KeyToDataUri(this.env, imageKey, userEmail)
            : imageUrl;
          const params = buildGenParams(kind, { modelId, prompt, lyrics, imageUrl: resolvedImage });

          const gateway = await loadGatewayCredentials(this.env, userEmail);
          if (!gateway?.gatewayId) {
            throw new Error(GATEWAY_NOT_CONFIGURED_MSG);
          }
          const aiCtx: AiContext = { env: this.env, gateway };
          const result = await aiRun(aiCtx, modelId, params) as LongRunResult;

          if (result.state && result.state !== "Completed") {
            throw new Error(`Unexpected gen state: ${result.state}`);
          }
          const url = kind === "video"
            ? result.result?.video
            : (result.audio ?? result.result?.audio);
          if (!url) {
            throw new Error(`Gen completed but no ${kind} URL. Raw: ${JSON.stringify(result).slice(0, 500)}`);
          }
          return url;
        }
      );

      // Step 2: download artifact and upload to R2 (combined; can't pass
      // bytes between steps due to the 1 MiB step return cap).
      const { r2Key, mime } = await step.do(
        "download-and-store",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<{ r2Key: string; mime: string }> => {
          const aresp = await fetch(artifactUrl);
          if (!aresp.ok) throw new Error(`Fetch ${aresp.status} from ${artifactUrl.slice(0, 100)}`);
          // For video, force video/mp4. CF's catalog R2 and many CDNs serve
          // MP4 as application/octet-stream, which would cause R2 keys to
          // end in .bin when upstream serves application/octet-stream.
          const upstreamMime = aresp.headers.get("content-type") || "";
          const finalMime = kind === "video"
            ? "video/mp4"
            : (upstreamMime || "audio/mpeg");
          const bytes = new Uint8Array(await aresp.arrayBuffer());
          const key = await r2Put(this.env, "out", finalMime, bytes, userEmail);
          return { r2Key: key, mime: finalMime };
        }
      );

      // Step 3: finalize the D1 row.
      await step.do(
        "finalize-d1",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<void> => {
          const outputArtifact: OutputArtifact = {
            key: r2Key,
            mime,
            type: kind === "video" ? "video" : "audio",
          };
          const latency = Date.now() - Date.parse(startedAtIso);
          await this.env.DB.prepare(
            `UPDATE chats SET status = 'done', output_artifact = ?, latency_ms = ? WHERE id = ?`
          )
            .bind(JSON.stringify(outputArtifact), latency, rowId)
            .run();
        }
      );
    } catch (err) {
      // A step exhausted its retries (or some non-step code threw). Mark the
      // D1 row failed so the polling client gets a clear error, then re-throw
      // so the workflow instance itself is reported as errored in the
      // dashboard (preserves observability).
      const m = err instanceof Error ? err.message : String(err);
      await failRow(m);
      throw err;
    }
  }
}

