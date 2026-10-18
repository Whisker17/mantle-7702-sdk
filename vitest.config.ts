import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mantle-aa/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
      "@mantle-aa/sponsor": fileURLToPath(
        new URL("./packages/sponsor/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts", "e2e/**/*.test.ts"],
  },
});
