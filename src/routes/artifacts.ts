// Artifact serving: stream an R2 object (chat input or generated output) gated
// by the customMetadata.user_email ownership check, with conditional-GET (ETag)
// revalidation support.

import type { Env } from "../env";
import { getUserEmail } from "./shared";

// ---------- Artifact serving ----------

export async function handleArtifact(request: Request, env: Env, key: string): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  // Artifacts (chat input + output) all live on env.R2.
  const bucket = env.R2;
  // v0.142.0: forward the request's conditional headers (If-None-Match) to R2.
  // With a conditional get, R2 returns the object WITHOUT a body when the
  // client's ETag still matches, and we reply 304 (a ~0-byte revalidation);
  // a changed object returns fresh bytes. customMetadata is present on the
  // body-less R2Object too, so the ownership check is unaffected.
  const obj = await bucket.get(key, { onlyIf: request.headers });
  if (!obj) return new Response("Not Found", { status: 404 });

  // Authorization: only the user who created the artifact may fetch it.
  // We stored user_email in customMetadata at put time. Checked before any
  // 304 so a non-owner with a guessed ETag still gets 403, never a hit/miss.
  const owner = obj.customMetadata?.user_email;
  if (owner !== userEmail) {
    return new Response("Forbidden", { status: 403 });
  }

  // Use the last path segment of the R2 key as a download filename hint, so
  // <a download> on the client saves with the right extension (mp4/png/etc)
  // rather than defaulting to .bin or no extension.
  const filename = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;

  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  // Revalidate every fetch instead of blind-caching for an hour: no-cache means
  // the browser keeps its copy but must check ETag first, so an overwritten
  // artifact shows fresh while an unchanged one costs only a 304. MP4s (which
  // never overwrite, since a new render is a new job-id key) just 304 cheaply.
  headers.set("cache-control", "private, no-cache");
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  headers.set("content-disposition", `inline; filename="${filename}"`);

  // R2 returns a body-less R2Object when the conditional matched (not modified).
  if (!("body" in obj) || obj.body === null) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
}

