import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["index.ts"],
      reporter: ["text", "text-summary", "html", "lcov"],
      // Ratcheted floor -- enforced by the pre-push hook and CI. Raise as coverage grows.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 70,
        lines: 80,
      },
    },
  },
});
