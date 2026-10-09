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

// 2c. expo-router with the navigation calls services make (logout calls canDismiss/dismissAll
// inside a try, so a missing one silently skips the wipe that follows). Integration only, by
// doMock for the same hoisting reason as expo-constants; the legacy mock stays as it was.
jest.doMock('expo-router', () => {
  const nav = () => ({
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
    dismissTo: jest.fn(),
    canDismiss: jest.fn(() => false),
    canGoBack: jest.fn(() => false),
    setParams: jest.fn(),
  });
  return {
    __esModule: true,
    router: nav(),
    useRouter: jest.fn(() => nav()),
    usePathname: jest.fn(() => '/'),
    useLocalSearchParams: jest.fn(() => ({})),
    useGlobalSearchParams: jest.fn(() => ({})),
    useSegments: jest.fn(() => []),
    useFocusEffect: jest.fn(),
  };
});

// 2d. expo-web-browser with the real presentation-style values and the Android Custom Tabs query
// lib/web-browser-utils.ts calls. Integration only (doMock): the legacy mock is shared and stays.
jest.doMock('expo-web-browser', () => ({
  __esModule: true,
  openBrowserAsync: jest.fn(() => Promise.resolve({ type: 'opened' })),
  dismissBrowser: jest.fn(),
  getCustomTabsSupportingBrowsersAsync: jest.fn(() =>
    Promise.resolve({ browserPackages: [], servicePackages: [], preferredBrowserPackage: null, defaultBrowserPackage: null }),
  ),
  WebBrowserPresentationStyle: {
    FULL_SCREEN: 'fullScreen',
    PAGE_SHEET: 'pageSheet',
    FORM_SHEET: 'formSheet',
    CURRENT_CONTEXT: 'currentContext',
    OVER_FULL_SCREEN: 'overFullScreen',
    OVER_CURRENT_CONTEXT: 'overCurrentContext',
    POPOVER: 'popover',
    AUTOMATIC: 'automatic',
  },
}));

// 2e. llama.rn as the shared native mock, except toggleNativeLog resolves: the real
// modelManager.initBaseModel chains .catch on it. Scripted behaviour per test comes from
// installLlama (test/helpers/llama.ts). Integration only (doMock); legacy keeps its mock.
jest.doMock('llama.rn', () => ({
  initLlama: jest.fn(),
  releaseAllLlama: jest.fn(),
  loadLlamaModelInfo: jest.fn(() => Promise.resolve({})),
  toggleNativeLog: jest.fn(() => Promise.resolve()),
  addNativeLogListener: jest.fn(() => ({ remove: jest.fn() })),
}));

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
// Harness modules the hooks below call, loaded here at setup level: nothing is first required
// inside a hook (a module that registers hooks on load, such as @testing-library/react-native,
// fails the test when loaded there). The DB stays lazy so a test's own jest.mock still applies.
const { assertNoGatewayViolations } = require('./test/helpers/gateway');
const { resetStorage } = require('./test/helpers/storage');
const { resetScenario } = require('./test/mock-backend/scenario');
const { resetAuthState } = require('./test/mock-backend/auth');
const { resetGatewayState } = require('./test/mock-backend/gateway/handlers');
const { resetDatabase } = require('./test/helpers/db');
server.listen({ onUnhandledRequest: (req) => unhandled.push(`${req.method} ${req.url}`) });
afterEach(() => {
  server.resetHandlers();
  jest.useRealTimers();
  const u = unhandled.splice(0);
  // E2EE contract breaks (cleartext tool keys, wrong headers, undecryptable envelopes) fail the
  // test; tests that plant one on purpose drain it with takeGatewayViolations().
  assertNoGatewayViolations();
  if (u.length) {
    throw new Error('Unhandled requests (add a handler or a server.use override):\n' + u.join('\n'));
  }
});
afterAll(() => server.close());

// 12. Per-test reset.
beforeEach(async () => {
  resetStorage();
  resetScenario();
  resetAuthState();
  resetGatewayState();
  await resetDatabase();
});
