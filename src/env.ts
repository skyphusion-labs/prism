// Worker Env binding (v0.19.0).
//
// Extracted from src/index.ts so provider modules (anthropic, xai, google,
// workers-ai) and future feature modules can import it without circular
// reference to the worker entry. The runtime binding shape is identical
// to what wrangler types regenerate from wrangler.toml; this file is the
// hand-authored interface the worker code references for type checking.
//
// Adding a binding: update wrangler.example.toml, regenerate types
// (`npx wrangler types`), then mirror the new field here. Optional secrets
// (BYOK keys, gateway tokens) stay optional in this interface so missing-
// secret runtime paths surface meaningful errors instead of TypeScript
// telling deployers they need fields they may legitimately not have set.

// Subset of search-mcp AiSearchChunk that SearchEntrypoint.search returns.
// Extra fields on the wire are ignored. The mapper lives in
// src/skyphusion-search.ts.
export interface SearchChunk {
  score?: number;
  text?: string;
  item?: {
    key?: string;
    metadata?: { repo?: string; path?: string };
  };
}

// Named RPC entrypoint on the skyphusion-search Worker. The binding
// field in wrangler is `entrypoint = "SearchEntrypoint"`. The method
// is search(question), not POST /ask.
// https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints
export interface SearchEntrypoint extends Rpc.WorkerEntrypointBranded {
  search(question: string): Promise<{ chunks: SearchChunk[] }>;
}

export interface Env {
  AI: Ai;
  DB: D1Database;
  R2: R2Bucket;
  VEC: VectorizeIndex;
  /**
   * Filter RAG retrieval by `user_email` in Vectorize itself (skyphusion-labs/fleet-chezmoi#1636).
   * "on" (also "1" / "true") turns it on; anything else, including unset, is off.
   *
   * DEFAULT OFF, ON PURPOSE. The filter needs a `user_email` metadata index on the Vectorize index
   * AND every existing vector re-upserted after that index exists (metadata indexes are not
   * retroactive). Turned on before both are done, it hides every older vector and retrieval returns
   * nothing. Order: create the metadata index, run scripts/vectorize-backfill-metadata.mjs, then set
   * this. See MIGRATIONS.md.
   */
  VEC_METADATA_FILTER?: string;
  ASSETS: Fetcher;
  // v0.167.0 (issue #80): deployment auth plane. "public" = first-party
  // username/password accounts, session cookie identity, and fail-closed
  // per-user gateway credentials (visitor inference never bills the host).
  // Unset or "access" = trust Cloudflare Access (Cf-Access-Authenticated-User-
  // Email) and keep worker-secret gateway fallback for private self-host.
  // A var, not a secret; set it in wrangler.toml [vars].
  AUTH_MODE?: string;
  /** access mode only: set to "1" to allow anonymous when Access header is absent (local dev). */
  ACCESS_ALLOW_ANONYMOUS?: string;
  GATEWAY_ID?: string;
  // v0.164.0: optional on the worker when running in public demo mode; each
  // user may store their own gateway slug in D1 user_prefs instead.
  // v0.12.0: Workflow binding for Unified Billing video + music gen. The
  // class is LongRunWorkflow, defined at the bottom of src/index.ts. Each
  // instance invokes env.AI.run (long-running), downloads the artifact,
  // uploads to R2, and finalizes the D1 row across retryable steps.
  LONGRUN: Workflow;
  // v0.108.0: per-session Durable Object that wraps a @cf/deepgram/flux
  // conversational STT WebSocket so the final transcript persists to /history
  // on close (a plain Worker has no reliable post-101 hook to write D1). Class
  // SttSession in src/stt-session.ts. One DO instance per session (newUniqueId).
  STT_SESSION: DurableObjectNamespace;
  // Unified Billing auth for Anthropic, xAI, and proxied partners. Bearer token
  // sent as cf-aig-authorization. Also used when Authenticated Gateway is on.
  // v0.164.0: optional on the worker in public demo mode (per-user token in D1).
  CF_AIG_TOKEN?: string;
  /**
   * Optional origin for prism-control-plane (default https://play-proxy.skyphusion.org).
   * Must be an allowlisted host; user prefs cannot override (SSRF).
   */
  CONTROL_PLANE_URL?: string;
  /** Set to "true" to allow http://localhost for local wrangler + local control-plane. */
  CONTROL_PLANE_ALLOW_LOCALHOST?: string;
  // Optional. Sole deployer BYOK exception (v0.174.0 restore of the v0.22.1
  // path): when set, openai/gpt-image-* go direct to api.openai.com for
  // transparent PNG (background + output_format). When unset, those models
  // stay on Unified Billing and render opaque. No other provider reads a
  // deployer key.
  OPENAI_API_KEY?: string;
  // Service binding to the skyphusion-search Worker, named entrypoint
  // SearchEntrypoint. Optional: when the binding is absent, web search
  // reports that source as "absent" and Wikipedia still runs. Declared
  // in wrangler.example.toml as [[services]] binding = "SEARCH",
  // service = "skyphusion-search", entrypoint = "SearchEntrypoint".
  // search(question) returns { chunks }. This is not POST /ask.
  SEARCH?: Service<SearchEntrypoint>;
}
