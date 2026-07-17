import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Workers-runtime integration suite (v0.164.4, issue #84).
//
// Runs the actual worker fetch handler (src/index.ts) inside workerd via
// @cloudflare/vitest-pool-workers, so routing, getUserEmail, per-user D1
// scoping, the R2 ownership gate, /api/prefs, and the gateway 412 path are
// under CI instead of verified only by live wrangler dev smoke.
//
// Bindings are Miniflare-local and fork-safe (no secrets, no network):
//   - DB (D1) and R2 are real local Miniflare simulators; the schema is
//     applied per test from schema.sql (see tests-integration/worker.test.ts).
//   - AI, VEC, LONGRUN, STT_SESSION are inert JSON stubs. The routes under
//     test never call them; the gateway 412 gate short-circuits before any
//     env.AI.run, so no Workers AI / gateway network call is ever made.
//   - ASSETS is a mock Fetcher returning 404, so the "no route matched"
//     fallthrough is observable without shipping the public/ tree into the
//     runtime.
//
// compatibilityDate mirrors wrangler.example.toml so the module parses under
// the same runtime semantics as production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-05-01",
        d1Databases: ["DB"],
        r2Buckets: ["R2"],
        bindings: {
          AI: {},
          VEC: {},
          LONGRUN: {},
          STT_SESSION: {},
        },
        serviceBindings: {
          ASSETS: () => new Response("assets-fallthrough", { status: 404 }),
        },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["tests-integration/**/*.test.ts"],
  },
});
