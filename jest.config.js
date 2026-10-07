module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    // `@legendapp/motion` is in here for the same reason, one layer further
    // out: `components/ui/tooltip` imports it, and ArticleMetaRow imports the
    // tooltip for the failed-translation affordance — which drags it into
    // every suite that renders a card.
    //
    // `@gluestack-ui/*` ships untranspiled ESM. It only started mattering when
    // the shared glass primitive (components/custom/GlassSurface.tsx) pulled
    // `@/components/ui/box` into test graphs that had never imported a
    // gluestack component before — without it those suites die on
    // `SyntaxError: Unexpected token 'export'` from @gluestack-ui/utils.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|better-auth|@better-auth|@apollo|graphql|nanostores|@noble|@gluestack-ui/.*|@legendapp/.*)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: [
    '**/__tests__/**/*.(test|spec).[jt]s?(x)',
    '**/?(*.)+(test|spec).[jt]s?(x)',
  ],
  // harness-local/ is a standalone Node executor (tsx scripts, not jest specs) —
  // its testMatch shape already excludes them, but this is belt-and-suspenders
  // so a future harness-local/**/*.test.ts fixture never gets picked up here.
  //
  // .claude/worktrees/ is a full duplicate repo tree (428 spec files). Its specs
  // resolve `@/…` through THIS rootDir's alias, so they run the LIVE code
  // against STALE expectations: the suite ran twice, and any deliberate change
  // to a component here failed in the copy while passing in the original. That
  // is a false red by construction, not coverage.
  testPathIgnorePatterns: ['/node_modules/', '/harness-local/', '/.claude/worktrees/'],
  // Owner rule: unit tests cover plain, non-React logic only (no render,
  // snapshot, hook or e2e tests). So coverage measures plain `.ts` under lib/,
  // minus hooks. Also excluded: generated GraphQL types, locale data, the
  // native DB singleton (instantiates SQLiteAdapter at import; every consumer
  // mocks it), and the three thin llama.rn/react-native-fs native toolkit
  // wrappers (no meaningful pure logic to unit-test).
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/hooks/**',
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
  // Floor of the aggregate measured after the navx2 P0 test cleanup (83.46 /
  // 77.75 / 78.29 / 85.42). Only `test:coverage` checks it; plain `jest` does
  // not. Ratchet up as plain-logic tests are added.
  coverageThreshold: {
    global: {
      branches: 77,
      functions: 78,
      lines: 85,
      statements: 83,
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
