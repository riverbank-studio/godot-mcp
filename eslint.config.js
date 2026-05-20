// Flat config — ESLint v9+. Project is "type": "module", so a plain .js file is ESM.
// Uses the canonical typescript-eslint `tseslint.config()` helper to compose configs
// and merges in eslint-config-prettier last to disable rules that conflict with Prettier.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['build/**', 'coverage/**', 'node_modules/**', '**/*.gd'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
);
