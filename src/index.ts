// prism worker (play.skyphusion.org). This file is the router + orchestrator:
// the fetch handler below IS the route table (matched top-to-bottom; anything
// unmatched falls through to the ASSETS static frontend). Per-concern handlers
// live in src/routes/* (chat, history, conversations, documents, projects,
// artifacts, prefs, health, workflow) over the shared primitives in
// src/routes/shared.ts and the RAG engine in src/routes/rag.ts. See CLAUDE.md
// "Routes reference" for the full table.
//
// Auth is resolved in src/auth.ts: public mode gates every /api/* route (except
// the GET /api/models boot probe and the /api/auth/* endpoints) behind a
// session; access mode trusts the upstream Cloudflare Access identity. Local
// dev has neither in front; identity falls back per src/auth.ts.

import { MODELS } from "./models";
import type { Env } from "./env";
import { loadGatewayStatus } from "./gateway-credentials";
import {
  resolveIdentity,
  authMode,
  handleSignup,
  handleLogin,
  handleLogout,
  handleAccountDelete,
} from "./auth";
import { json } from "./routes/shared";
import { handleHealthDeep } from "./routes/health";
import { VERSION } from "./version";
import { handlePrefsGet, handlePrefsPatch } from "./routes/prefs";
import {
  handleChat,
  handleChatStream,
  handleTtsSpeak,
  handleJobPoll,
} from "./routes/chat";
import {
  handleHistoryList,
  handleHistoryGet,
  handleHistoryDelete,
} from "./routes/history";
import {
  handleConversationList,
  handleConversationGet,
  handleConversationDelete,
  handleConversationMoveToProject,
  handleConversationCompact,
  handleConversationCompactClear,
} from "./routes/conversations";
import {
  handleDocumentList,
  handleDocumentGet,
  handleDocumentUpload,
  handleDocumentDelete,
  handleImportStatus,
} from "./routes/documents";
import {
  handleProjectList,
  handleProjectGet,
  handleProjectCreate,
  handleProjectUpdate,
  handleProjectDelete,
  handleProjectDocAdd,
  handleProjectDocRemove,
  handleDiscordImport,
} from "./routes/projects";
import { handleArtifact } from "./routes/artifacts";
import { handleCspReport } from "./routes/csp-report";
import { CSP_HEADER, buildCspPolicy } from "./csp";

// Durable Object + Workflow classes must stay exported from the main entry so
// wrangler resolves each class_name against this module.
export { SttSession } from "./stt-session";
export { LongRunWorkflow } from "./routes/workflow";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cheap liveness check. No binding access; sub-millisecond response.
    // Use for high-frequency uptime polling (Kuma at 60s interval, etc).
    //
    // Carries `version` so "which code is serving?" is answerable from an
    // unauthenticated surface. A green deploy workflow proves the upload
    // succeeded, not that the running Worker is the code you think it is, and
    // until this field existed that question needed an account-scoped
    // Cloudflare token. It is on the LIVENESS probe deliberately: the answer
    // is about the deploy, not about the bindings, so it must not require
    // /health/deep's D1, R2 and Vectorize round-trips, and it has to survive
    // the 503 path. Value comes from src/version.ts, pinned to package.json by
    // a test that DERIVES the expected string rather than transcribing it.
    // See fleet-chezmoi#1641.
    if (url.pathname === "/health") {
      return json({ ok: true, ts: Date.now(), version: VERSION });
    }

    // Deep check: exercises D1, R2, Vectorize, and confirms the AI gateway
    // is configured. Returns 503 if any check fails so an uptime monitor
    // flips red. Slower than /health (50-200ms typical) so poll less
    // frequently (5min interval works well).
    if (url.pathname === "/health/deep" && request.method === "GET") {
      return handleHealthDeep(env);
    }

    // ---- Auth plane (v0.167.0, issue #80) ----
    // Boot probe is GET /api/models (below): reachable without a session, it
    // returns { mode, authenticated, user, username, gateway } so the SPA can
    // decide app vs signup in one call. Signup/login/logout are the only other
    // /api/* routes reachable without a session in public mode; they are
    // disabled (403) in access mode.
    if (url.pathname === "/api/auth/signup" && request.method === "POST") {
      return handleSignup(request, env);
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    // CSP violation collector (fleet-chezmoi#1646). Sits above the gate
    // deliberately: browsers post violation reports WITHOUT credentials, so a
    // session-gated collector would collect nothing. That makes it an
    // unauthenticated public write endpoint, and the handler is written for
    // that: body cap with refusal past it, fixed bounded projection, per-IP
    // rate limit with visible shedding, prune-on-write retention.
    if (url.pathname === "/api/csp-report" && request.method === "POST") {
      return handleCspReport(request, env);
    }

    // Public-mode gate: every other /api/* route requires a valid session.
    // GET /api/models is exempt (it is the unauthenticated boot probe). Uniform
    // 401 { code: "unauthenticated" } so the frontend routes the user to the
    // login screen. Access mode skips this entirely (Access gates upstream).
    if (
      authMode(env) === "public" &&
      url.pathname.startsWith("/api/") &&
      !(url.pathname === "/api/models" && request.method === "GET") &&
      (await resolveIdentity(request, env)) === null
    ) {
      return json({ error: "Authentication required.", code: "unauthenticated" }, { status: 401 });
    }

    // Session-authed account deletion (password re-entry enforced in handler).
    if (url.pathname === "/api/account" && request.method === "DELETE") {
      return handleAccountDelete(request, env);
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      // Boot probe: reachable without a session. Carries mode + authenticated so
      // the SPA gates itself in one call (no separate /api/session endpoint).
      // Access mode fails closed unless ACCESS_ALLOW_ANONYMOUS=1 (local dev only).
      const mode = authMode(env);
      const id = await resolveIdentity(request, env);
      const authenticated = id !== null;
      let username: string | null = null;
      let gateway;
      if (authenticated) {
        gateway = await loadGatewayStatus(env, id);
        if (mode === "access") {
          username = id; // the Access email is the handle
        } else {
          const row = await env.DB.prepare(`SELECT username FROM users WHERE id = ?`)
            .bind(id)
            .first<{ username: string }>();
          username = row?.username ?? null;
        }
      } else {
        gateway = {
          configured: false,
          source: "none" as const,
          gateway_id: null,
          cf_aig_token_set: false,
          account_id: null,
          account_id_required: false,
          control_plane_configured: false,
          control_plane_key_set: false,
        };
      }
      return json({ models: MODELS, mode, authenticated, user: id, username, gateway });
    }
    if (url.pathname === "/api/prefs" && request.method === "GET") {
      return handlePrefsGet(request, env);
    }
    if (url.pathname === "/api/prefs" && request.method === "PATCH") {
      return handlePrefsPatch(request, env);
    }
    // v0.104.0 / v0.108.0: conversational STT (@cf/deepgram/flux) over a
    // WebSocket. flux is websocket-only, so this is a WS upgrade endpoint, not a
    // chat model. The upgrade is forwarded to a per-session SttSession Durable
    // Object that bridges to flux and persists the final transcript to /history
    // on close. The original request carries the CF Access user header, which
    // the DO reads to attribute the row.
    if (url.pathname === "/api/stt/stream" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const stub = env.STT_SESSION.get(env.STT_SESSION.newUniqueId());
      return stub.fetch(request);
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }
    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      return handleChatStream(request, env, ctx);
    }
    // v0.118.0: lightweight TTS endpoint for the voice-chat loop. Synthesizes
    // text to speech (Deepgram Aura-2) and streams the audio bytes straight
    // back, WITHOUT persisting a chats row (unlike the tts MODEL path through
    // /api/chat). Used to speak the LLM's reply in hands-free voice chat.
    if (url.pathname === "/api/tts" && request.method === "POST") {
      return handleTtsSpeak(request, env);
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      return handleHistoryList(request, env);
    }

    if (url.pathname === "/api/documents") {
      if (request.method === "GET")  return handleDocumentList(request, env);
      if (request.method === "POST") return handleDocumentUpload(request, env);
    }

    const d = url.pathname.match(/^\/api\/documents\/(\d+)$/);
    if (d) {
      const id = Number(d[1]);
      if (request.method === "GET")    return handleDocumentGet(request, env, id);
      if (request.method === "DELETE") return handleDocumentDelete(request, env, id);
    }

    // v0.20.0: project endpoints. See handleProjectList for endpoint docs.
    if (url.pathname === "/api/projects") {
      if (request.method === "GET")  return handleProjectList(request, env);
      if (request.method === "POST") return handleProjectCreate(request, env);
    }
    const p = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    if (p) {
      const id = Number(p[1]);
      if (request.method === "GET")    return handleProjectGet(request, env, id);
      if (request.method === "PATCH")  return handleProjectUpdate(request, env, id);
      if (request.method === "DELETE") return handleProjectDelete(request, env, id);
    }
    const pd = url.pathname.match(/^\/api\/projects\/(\d+)\/documents\/(\d+)$/);
    if (pd) {
      const projectId = Number(pd[1]);
      const docId = Number(pd[2]);
      if (request.method === "POST")   return handleProjectDocAdd(request, env, projectId, docId);
      if (request.method === "DELETE") return handleProjectDocRemove(request, env, projectId, docId);
    }
    // v0.20.3: Discord export import into a project.
    const pi = url.pathname.match(/^\/api\/projects\/(\d+)\/import-discord$/);
    if (pi && request.method === "POST") {
      return handleDiscordImport(request, env, Number(pi[1]));
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      return handleConversationList(request, env);
    }
    const c = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_:-]+)$/);
    if (c) {
      if (request.method === "GET")    return handleConversationGet(request, env, c[1]);
      if (request.method === "DELETE") return handleConversationDelete(request, env, c[1]);
    }
    // v0.20.2: PATCH /api/conversations/:id/project to move a conversation
    // to/from a project (body: {project_id: number | null}).
    const cp = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_:-]+)\/project$/);
    if (cp && request.method === "PATCH") {
      return handleConversationMoveToProject(request, env, cp[1]);
    }
    // v0.175.7: compact older turns into a summary for model context.
    const cc = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_:-]+)\/compact$/);
    if (cc) {
      if (request.method === "POST") return handleConversationCompact(request, env, cc[1]);
      if (request.method === "DELETE") return handleConversationCompactClear(request, env, cc[1]);
    }

    const h = url.pathname.match(/^\/api\/history\/(\d+)$/);
    if (h) {
      const id = Number(h[1]);
      if (request.method === "GET")    return handleHistoryGet(request, env, id);
      if (request.method === "DELETE") return handleHistoryDelete(request, env, id);
    }

    const j = url.pathname.match(/^\/api\/job\/(\d+)$/);
    if (j && request.method === "GET") {
      return handleJobPoll(request, env, Number(j[1]));
    }

    // v0.26.0: poll a durable zip-import workflow by its instance id.
    const imp = url.pathname.match(/^\/api\/import\/([A-Za-z0-9-]+)$/);
    if (imp && request.method === "GET") {
      return handleImportStatus(request, env, imp[1]);
    }

    const a = url.pathname.match(/^\/api\/artifact\/(.+)$/);
    if (a && request.method === "GET") {
      return handleArtifact(request, env, decodeURIComponent(a[1]));
    }

    // ---- Security headers on the static surface (fleet-chezmoi#1646) ----
    //
    // SCOPE, stated so it is not mistaken for more than it is: these are
    // applied to the ASSETS responses, which is where the HTML and every
    // static file come from. API responses returned above do NOT carry them.
    // For CSP that is correct, since a policy only governs the document that
    // carries it. For HSTS it is a known and deliberate gap in phase one: a
    // browser that has loaded the page already holds the header, and widening
    // it to every route is a separate change to every response path.
    //
    // The three headers this deploy already carries (x-frame-options,
    // referrer-policy, x-content-type-options) are NOT set here. They are
    // applied at the edge by a zone Transform Rule for every host on the
    // zone, measured directly in the zone config. Setting them here would be
    // a duplicate CERTAINTY rather than a duplicate risk, and a duplicated
    // x-frame-options is worse than either value alone because agents
    // disagree about which wins. Bringing that rule under declared config is
    // fleet-chezmoi#1626; duplicating a control is not declaring it.
    const assetRes = await env.ASSETS.fetch(request);
    const isHtml = (assetRes.headers.get("content-type") || "").includes("text/html");
    const headers = new Headers(assetRes.headers);

    // ENFORCING as of the fleet-chezmoi#1646 promotion. Violations are now
    // BLOCKED, and still posted to the collector routed above, which is what
    // keeps this observable: the stored `disposition` reads `enforce` rather
    // than `report`, so a directive this policy gets wrong arrives as a row
    // naming what broke instead of as a user noticing a dead feature.
    //
    // The two exceptions the policy carries (`data:` on img-src, `blob:` on
    // media-src) were each established by an OBSERVED violation during the
    // report-only phase, never by reading the frontend and deciding what
    // looked necessary. See src/csp.ts for the provenance of each.
    //
    // Note the header NAME comes from the same module as the policy. Building
    // an enforcing policy and emitting it under the report-only name is a
    // decorative control that no test reading only one of the two can catch.
    if (isHtml) {
      headers.set(CSP_HEADER, buildCspPolicy());
    }

    // HSTS. Phase-one max-age is deliberately SHORT (1 day). A long max-age is
    // cached by every client that sees it and cannot be recalled, so shipping
    // six months on first rollout commits the estate to a promise nobody has
    // observed holding yet. Ramping is a one-line change once it has. No
    // preload, which is the genuinely irreversible one.
    headers.set("strict-transport-security", "max-age=86400; includeSubDomains");

    return new Response(assetRes.body, {
      status: assetRes.status,
      statusText: assetRes.statusText,
      headers,
    });
  },

};
