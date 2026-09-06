import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Vitest 5's own default exclude list is only node_modules/.git — it does
    // NOT exclude build output. apps/bot's tsc build compiles *.test.ts into
    // dist/ (see apps/bot/tsconfig.json), so without this, Vitest would also
    // pick up and re-run the compiled dist/**/*.test.js copies.
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
