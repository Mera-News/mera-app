// Existing transform allowlist. `msw` is appended for the integration project
// only: msw/node and its helper packages ship untranspiled ESM.
const ALLOW =
  '((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|better-auth|@better-auth|@apollo|graphql|nanostores|@noble|@gluestack-ui/.*|@legendapp/.*';
const MSW_ALLOW =
  'msw|@mswjs|@bundled-es-modules|@open-draft|until-async|rettime|outvariant|strict-event-emitter|headers-polyfill|graphql';

// `@legendapp/motion` is in the allowlist for the same reason, one layer further
// out: `components/ui/tooltip` imports it, and ArticleMetaRow imports the
// tooltip for the failed-translation affordance — which drags it into
// every suite that renders a card.
//
// `@gluestack-ui/*` ships untranspiled ESM. It only started mattering when
// the shared glass primitive (components/custom/GlassSurface.tsx) pulled
// `@/components/ui/box` into test graphs that had never imported a
// gluestack component before — without it those suites die on
// `SyntaxError: Unexpected token 'export'` from @gluestack-ui/utils.
const transformIgnorePatterns = [`node_modules/(?!${ALLOW})`];

// Tool output and native build trees: never specs, and Stryker's sandbox copies
// the whole tree under .stryker-tmp.
const IGNORED_DIRS = [
  '<rootDir>/.stryker-tmp',
  '<rootDir>/e2e-output',
  '<rootDir>/android',
  '<rootDir>/ios',
];

const base = {
  preset: 'jest-expo',
  transformIgnorePatterns,
  modulePathIgnorePatterns: IGNORED_DIRS,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'node',
  globals: {
    '__DEV__': true,
  },
};

module.exports = {
  // Test rules:
  // - Unit tests cover pure algorithms only, in lib/algorithms/__tests__/.
  // - Everything else is an integration test at a service or hook seam in
  //   test/integration/<area>/, run against MSW and the in-memory DB, with no
  //   component render or snapshot tests.
  // - `legacy` runs the pre-wave tests until P2 converts or deletes them.
  // - Coverage settings stay as they are until P5.
  //
  // Coverage measures plain `.ts` under lib/, minus hooks. Also excluded:
  // generated GraphQL types, locale data, the native DB singleton (instantiates
  // SQLiteAdapter at import; every legacy consumer mocks it), and the three thin
  // llama.rn/react-native-fs native toolkit wrappers (no meaningful pure logic).
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
  projects: [
    {
      ...base,
      displayName: 'legacy',
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
      //
      // test/ and lib/algorithms/ belong to the integration and unit projects.
      testPathIgnorePatterns: [
        '/node_modules/',
        '/harness-local/',
        '/.claude/worktrees/',
        '<rootDir>/test/',
        '<rootDir>/lib/algorithms/',
        ...IGNORED_DIRS,
      ],
    },
    {
      ...base,
      displayName: 'unit',
      testMatch: [
        '<rootDir>/lib/algorithms/__tests__/**/*.test.ts',
        '<rootDir>/test/unit/**/*.test.ts',
      ],
      testPathIgnorePatterns: ['/node_modules/', ...IGNORED_DIRS],
    },
    {
      ...base,
      displayName: 'integration',
      // Call history resets before every test; implementations (jest.fn(impl), the setup's
      // doMock factories) stay. resetMocks would wipe those, so it stays off.
      clearMocks: true,
      setupFilesAfterEnv: ['<rootDir>/jest.setup.integration.js'],
      testMatch: ['<rootDir>/test/integration/**/*.test.ts?(x)'],
      testPathIgnorePatterns: ['/node_modules/', ...IGNORED_DIRS],
      transformIgnorePatterns: [`node_modules/(?!${ALLOW}|${MSW_ALLOW})`],
      // msw's rettime dependency is ESM-only and ships .mjs, which the preset's
      // transform (\.[jt]sx?$) does not cover.
      transform: {
        // Same babel-jest options as jest-expo's preset, plus import() -> require(): Jest runs
        // CommonJS, so a real dynamic import rejects (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG)
        // and app code that catches it would skip whole branches unseen. Integration only.
        // Guarded by test/integration/harness/dynamic-import.test.ts.
        '\\.[jt]sx?$': [
          'babel-jest',
          {
            caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
            plugins: [require.resolve('./test/helpers/babel-dynamic-import.js')],
          },
        ],
        '\\.mjs$': 'babel-jest',
      },
      moduleNameMapper: {
        '^expo/fetch$': '<rootDir>/test/helpers/node-fetch.ts',
        '^@/(.*)$': '<rootDir>/$1',
      },
    },
  ],
};
