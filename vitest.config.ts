import { defineConfig } from "vitest/config";

// Root Vitest config (v0.164.4): aggregates two projects so a single
// `npm test` (`vitest run`) runs both suites, locally and in CI.
//
//   - "node"    -> vitest.node.config.ts    pure-function tests (Node env)
//   - "workers" -> vitest.workers.config.ts fetch-handler integration tests
//                                            (workerd via pool-workers)
//
// See each project config for why the split exists.
export default defineConfig({
  test: {
    projects: [
      "./vitest.node.config.ts",
      "./vitest.workers.config.ts",
    ],
  },
});
