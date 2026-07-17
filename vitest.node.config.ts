import { defineConfig } from "vitest/config";

// Node-env pure-function suite (v0.18.0, split out in v0.164.4).
//
// The parsers under test (parseBedrockEventStreamFrames, SSE framers, chunking,
// output extraction, param builders, Discord parsing) use only standard web
// APIs (TextDecoder, Uint8Array, DataView) available natively in Node as well
// as the Workers runtime. They do NOT need the Workers runtime, so they run
// under plain Vitest in Node: substantially faster than booting workerd.
//
// The fetch-handler integration suite lives in the separate Workers-runtime
// project (vitest.workers.config.ts); both are aggregated by vitest.config.ts.
export default defineConfig({
  test: {
    name: "node",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
