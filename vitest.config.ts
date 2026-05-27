import { defineConfig } from "vitest/config";

// v0.18.0: Vitest configuration for pure-function unit tests.
//
// The parsers under test (parseBedrockEventStreamFrames, etc.) use only
// standard web APIs (TextDecoder, Uint8Array, DataView) which are available
// natively in Node 18+ as well as the Workers runtime. We do NOT need
// @cloudflare/vitest-pool-workers for these unit tests; plain Vitest under
// Node is sufficient and substantially faster.
//
// Future tests that need the Workers runtime (e.g. integration tests
// hitting the worker fetch handler) would warrant adding the pool-workers
// adapter, but the goal here is regression coverage on parsing code that
// has no Workers-specific behavior.

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
