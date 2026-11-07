import { defineConfig } from "vitest/config";

// Default (mocked) suite. Live tests have their own config: vitest.live.config.ts.
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
  },
});
