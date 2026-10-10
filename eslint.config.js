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
            { group: ['@/*', '!@/lib/algorithms/*'], message: ALGORITHMS_PURE, allowTypeImports: true },
            { group: ['../*', '../**'], message: ALGORITHMS_PURE, allowTypeImports: true },
          ],
        },
      ],
    },
  },
]);
