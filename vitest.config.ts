import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["index.ts", "markdown.ts"],
      reporter: ["text", "text-summary", "html", "lcov"],
      // Per file rather than aggregate, so neither file can hide a regression behind the other.
      // Enforced by the pre-push hook and CI.
      //
      // These floors sit a little under what the suite reaches, on purpose. A 100% floor makes
      // the number the goal: the last few points get bought with tests that call a function to
      // reach a line rather than to assert anything, and then real code cannot be added without
      // one. Presentation-only code -- renderCall, invalidate -- is deliberately untested, which
      // is what pi does with its own tools' renderers.
      thresholds: {
        "index.ts": { statements: 92, functions: 85, lines: 92, branches: 76 },
        "markdown.ts": { statements: 100, functions: 100, lines: 100, branches: 90 },
      },
    },
  },
});
