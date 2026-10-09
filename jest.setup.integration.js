// Setup for the `integration` Jest project: real stores, MSW, an in-memory
// WatermelonDB, stateful storage and real SHA-256. Only native edges are mocked.

// 1. Env. Loopback so a stray un-intercepted request can never leave the machine.
process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT = 'http://127.0.0.1:8790';
process.env.EXPO_PUBLIC_AUTH_ENDPOINT = 'http://127.0.0.1:8790';
process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'http://127.0.0.1:8790';
process.env.EXPO_PUBLIC_REVENUECAT_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY || 'test_rc_key';
delete process.env.EXPO_PUBLIC_E2E;

// 2. Native-edge mocks shared with the legacy project.
require('./jest.setup.native.js');

// 2b. expo-constants with the enums real expo-linking reads (the legacy mock in
// jest.setup.native.js has none, so expo-linking threw on ExecutionEnvironment.StoreClient,
// and better-auth's expo client reaches expo-linking). 'standalone' = a release build.
// doMock, not mock: babel hoists jest.mock above the require of jest.setup.native.js, whose
// own expo-constants mock would then win.
jest.doMock('expo-constants', () => {
  const ExecutionEnvironment = { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' };
  const AppOwnership = { Expo: 'expo' };
  const Constants = {
    executionEnvironment: ExecutionEnvironment.Standalone,
    appOwnership: null,
    expoConfig: {
      scheme: 'exampleapp',
      slug: 'exampleapp',
      extra: { eas: { projectId: '00000000-0000-0000-0000-000000000000' } },
    },
  };
  return { __esModule: true, default: Constants, ExecutionEnvironment, AppOwnership };
});

// 3. expo-translate-text: identity translation, same export names as the package.
jest.mock('expo-translate-text', () => {
  class TranslationError extends Error {}
  return {
    __esModule: true,
    TranslationError,
    onTranslateTask: jest.fn(async ({ input, targetLangCode }) => ({
      translatedTexts: input,
      sourceLanguage: null,
      targetLanguage: targetLangCode ?? 'en',
    })),
    onTranslateSheet: jest.fn(async ({ input }) => input),
  };
});

// 4-5. Stateful storage (cleared in the per-test reset below).
jest.mock('expo-secure-store', () => require('./test/helpers/storage').secureStoreModule);
jest.mock(
  '@react-native-async-storage/async-storage',
  () => require('./test/helpers/storage').asyncStorageModule,
);

// 6. expo-crypto with real SHA-256 and real randomness, same constant values as
// the package (node_modules/expo-crypto/build/Crypto.types.js).
jest.mock('expo-crypto', () => {
  const nodeCrypto = require('node:crypto');
  const CryptoDigestAlgorithm = {
    SHA1: 'SHA-1',
    SHA256: 'SHA-256',
    SHA384: 'SHA-384',
    SHA512: 'SHA-512',
    MD2: 'MD2',
    MD4: 'MD4',
    MD5: 'MD5',
  };
  const CryptoEncoding = { HEX: 'hex', BASE64: 'base64' };
  return {
    __esModule: true,
    CryptoDigestAlgorithm,
    CryptoEncoding,
    digestStringAsync: async (alg, data, opts) =>
      nodeCrypto
        .createHash(alg.toLowerCase().replace('-', ''))
        .update(data)
        .digest(opts?.encoding === CryptoEncoding.BASE64 ? 'base64' : 'hex'),
    getRandomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
    getRandomBytesAsync: async (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
    randomUUID: () => nodeCrypto.randomUUID(),
  };
});

// 7. In-memory DB: the real lib/database/index.ts runs on a LokiJS adapter.
jest.mock(
  '@nozbe/watermelondb/adapters/sqlite',
  () => require('./test/helpers/memory-sqlite-adapter'),
);

// 8. Drivable AppState (replaces RN's own jest mock for this path).
jest.mock('react-native/Libraries/AppState/AppState', () => ({
  __esModule: true,
  default: require('./test/helpers/app-state').appStateModule,
}));

// 9. Reanimated (its native worklets part cannot initialise in Node), safe area.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
// RN's codegen babel plugin leaves an `export var __INTERNAL_VIEW_CONFIG` in these
// native-component specs under Jest ("Unexpected token 'export'"), and
// reanimated's ScrollView pulls them in. Host-component strings stand in.
jest.mock(
  'react-native/src/private/specs_DEPRECATED/components/AndroidHorizontalScrollContentViewNativeComponent',
  () => ({ __esModule: true, default: 'AndroidHorizontalScrollContentView' }),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// 10. Console.
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
};

// 11. MSW lifecycle. An unhandled request is recorded and fails the test in afterEach.
// listen() runs at setup load, BEFORE the test file's imports: better-auth captures
// globalThis.fetch when createAuthClient runs (lib/auth-client.ts at import), so a module
// loaded before the patch would send real requests that MSW never sees. Guarded by
// test/integration/harness/fetch-capture.test.ts.
const { server, unhandled } = require('./test/helpers/msw');
server.listen({ onUnhandledRequest: (req) => unhandled.push(`${req.method} ${req.url}`) });
afterEach(() => {
  server.resetHandlers();
  jest.useRealTimers();
  const u = unhandled.splice(0);
  // E2EE contract breaks (cleartext tool keys, wrong headers, undecryptable envelopes) fail the
  // test; tests that plant one on purpose drain it with takeGatewayViolations().
  require('./test/helpers/gateway').assertNoGatewayViolations();
  if (u.length) {
    throw new Error('Unhandled requests (add a handler or a server.use override):\n' + u.join('\n'));
  }
});
afterAll(() => server.close());

// 12. Per-test reset.
beforeEach(async () => {
  require('./test/helpers/storage').resetStorage();
  require('./test/mock-backend/scenario').resetScenario();
  require('./test/mock-backend/auth').resetAuthState();
  require('./test/mock-backend/gateway/handlers').resetGatewayState();
  await require('./test/helpers').resetDatabase();
});
