import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import repertoire from "eslint-plugin-repertoire";
import markdown from "@eslint/markdown";
import * as jsonParser from "jsonc-eslint-parser";
import * as yamlParser from "yaml-eslint-parser";

// Prose is checked in every file the project holds, so the character rule is
// listed once and applied per language below.
const repertoireRules = {
  "repertoire/no-undeclared-characters": "error",
};

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**"] },

  // TypeScript, linted with type information. Scoped to `.ts`: the type-aware
  // sets read the checker, and pointing them at a YAML or markdown file asks
  // for type information that no parser can produce.
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { repertoire },
    rules: {
      // Numbers interpolated into strings are fine and idiomatic.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      ...repertoireRules,
    },
  },

  // The flat config file and any other plain JS: not part of the TS program, so
  // only the untyped set applies.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [eslint.configs.recommended],
    plugins: { repertoire },
    rules: repertoireRules,
  },

  {
    files: ["**/*.md"],
    language: "markdown/gfm",
    plugins: { markdown, repertoire },
    rules: repertoireRules,
  },

  {
    files: ["**/*.json"],
    languageOptions: { parser: jsonParser },
    plugins: { repertoire },
    rules: repertoireRules,
  },

  {
    files: ["**/*.{yml,yaml}"],
    languageOptions: { parser: yamlParser },
    plugins: { repertoire },
    rules: repertoireRules,
  },

  // Keep Prettier's formatting authority; disable ESLint rules that would conflict.
  prettier,
);
