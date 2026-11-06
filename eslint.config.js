// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// lib/algorithms is pure: plain functions over plain data, loadable from Node with nothing mocked.
// The import-graph test (lib/algorithms/__tests__/purity.test.ts) is the authority; this rule is
// the fast signal in the editor. Type-only imports are allowed (they vanish at compile time).
const ALGORITHMS_PURE = 'lib/algorithms is pure: no React, React Native, Expo, Sentry, auth, DB, store, i18n runtime or app module.';

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  // React Compiler rules. A fix can compile a component for the first time, which jest cannot check,
  // so the work lives in plans/ready_to_implement/REACT_COMPILER_LINT_PLAN.md (in the workspace root).
  {
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
    },
  },
  {
    files: ['jest.setup*.js'],
    languageOptions: {
      globals: { jest: 'readonly', afterEach: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    files: ['app.config.js', 'jest.gate.config.js', 'eval/**/*.js', 'scripts/**/*.js', 'test/helpers/*.config.js'],
    languageOptions: { globals: { __dirname: 'readonly' } },
  },
  // Maestro scripts run on GraalJS, which has no let/const worth trusting here: var only.
  {
    files: ['.maestro/scripts/*.js'],
    languageOptions: {
      globals: { http: 'readonly', MOCK: 'readonly', IMAGE_ORIGIN: 'readonly', SCENARIO: 'readonly' },
    },
    rules: { 'no-var': 'off' },
  },
  // Two export-stars overlap on four type names (same types, re-exported); an explicit export only adds reports.
  {
    files: ['lib/news-harness/index.ts'],
    rules: { 'import/export': 'off' },
  },
  // expo-notifications re-exports its enums through export-star, which the import resolver cannot follow.
  {
    files: ['lib/notification-service.ts'],
    rules: { 'import/namespace': 'off' },
  },
  {
    files: ['lib/algorithms/**/*.ts', 'lib/algorithms/**/*.tsx'],
    ignores: ['lib/algorithms/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-*',
                'react-native',
                'react-native/*',
                'react-native-*',
                'expo',
                'expo/*',
                'expo-*',
                '@expo/*',
                '@sentry/*',
                'better-auth',
                'better-auth/*',
                '@better-auth/*',
                '@nozbe/*',
                'zustand',
                'zustand/*',
                '@apollo/*',
                'i18next',
                'react-i18next',
              ],
              message: ALGORITHMS_PURE,
              allowTypeImports: true,
            },
            // A regex, not a gitignore group: a negated child (`!@/lib/algorithms/*`) cannot re-include
            // a path whose parent `@/*` already matched, so the group form flagged algorithm-to-algorithm imports.
            { regex: '^@/(?!lib/algorithms/)', message: ALGORITHMS_PURE, allowTypeImports: true },
            { group: ['../*', '../**'], message: ALGORITHMS_PURE, allowTypeImports: true },
          ],
        },
      ],
    },
  },
]);
