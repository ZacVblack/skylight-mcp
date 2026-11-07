import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Default (mocked) suite. Live tests have their own config: vitest.live.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      // The Workers runtime module does not exist in Node; tests get a small stand-in.
      "cloudflare:workers": fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["tests/setup.ts"],
  },
});
