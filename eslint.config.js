// Flat config — ESLint v9+. Project is "type": "module", so a plain .js file is ESM.
// Uses the canonical typescript-eslint `tseslint.config()` helper to compose configs
// and merges in eslint-config-prettier last to disable rules that conflict with Prettier.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Minimal Node.js global identifiers needed for benchmark .mjs scripts.
 * Listed explicitly to avoid a `globals` package dependency.
 */
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
};

export default tseslint.config(
  {
    ignores: ["build/**", "coverage/**", "node_modules/**", "**/*.gd"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  // Benchmark scripts are plain-JS .mjs Node scripts — enable Node globals.
  {
    files: ["benchmarks/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
);
