module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|better-auth|@better-auth|@apollo|graphql|nanostores|@noble)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: [
    '**/__tests__/**/*.(test|spec).[jt]s?(x)',
    '**/?(*.)+(test|spec).[jt]s?(x)',
  ],
  // Coverage spans the whole logic layer (lib/**). Excluded: generated GraphQL
  // types, locale data, the native DB singleton (instantiates SQLiteAdapter at
  // import — every consumer mocks it), and the three thin llama.rn/react-native-fs
  // native toolkit wrappers (no meaningful pure logic to unit-test).
  collectCoverageFrom: [
    'lib/**/*.{ts,tsx}',
    '!lib/generated/**',
    '!lib/locales/**',
    '!lib/database/index.ts',
    '!lib/apollo-client.ts',
    '!lib/__test-helpers__/**',
    '!lib/mera-protocol-toolkit/core/modelManager.ts',
    '!lib/mera-protocol-toolkit/core/adapterManager.ts',
    '!lib/mera-protocol-toolkit/core/downloadService.ts',
    '!lib/generated/**',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  // Gate set just below the current measured aggregate so `test:coverage` passes
  // with headroom. Statements/functions/lines clear 90%; branches sits at ~87%
  // (the async-job-reconciler dynamic-import paths are the main remaining gap —
  // see pending-mera-app-test-plan.md). Ratchet these up as that gap closes.
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 92,
      lines: 92,
      statements: 92,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'node',
  globals: {
    '__DEV__': true,
  },
};
