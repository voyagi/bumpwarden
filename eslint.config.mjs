import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Complexity budgets are deliberately high (25): they catch genuinely tangled functions, not
// style. A hit means refactor the hotspot, or raise the limit for that one file with a reason.
const COMPLEXITY_BUDGET = 25;

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '**/*.config.{ts,js,mjs,cjs}',
      'scripts/check-client-secrets.mjs',
      'scripts/check-client-secrets.mutants.mjs',
      'verify-ship.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { sonarjs },
    rules: {
      complexity: ['error', COMPLEXITY_BUDGET],
      'sonarjs/cognitive-complexity': ['error', COMPLEXITY_BUDGET],
    },
  },
  {
    // Test files legitimately grow large describe trees; the complexity floors are for shipped code.
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      complexity: 'off',
      'sonarjs/cognitive-complexity': 'off',
    },
  },
  {
    // Tooling that must stay CommonJS (dependency-cruiser reads a .cjs config).
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
