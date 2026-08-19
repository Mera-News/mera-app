// Baseline EXPO_PUBLIC_* env so lib/config/endpoints.ts (read at module load,
// not inlined) doesn't hard-crash any test that transitively imports it.
// endpoints.test.ts manages its own env per-case and overrides these.
process.env.EXPO_PUBLIC_AUTH_ENDPOINT =
  process.env.EXPO_PUBLIC_AUTH_ENDPOINT || 'https://auth.test';
process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT =
  process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT || 'https://api.test';
process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT =
  process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT || 'https://inference.test';
process.env.EXPO_PUBLIC_REVENUECAT_API_KEY =
  process.env.EXPO_PUBLIC_REVENUECAT_API_KEY || 'test_rc_key';

// Suppress Expo Winter warnings and polyfills
global.__ExpoImportMetaRegistry = {
  register: jest.fn(),
  get: jest.fn(),
};

// Polyfill structuredClone if not available
if (typeof global.structuredClone === 'undefined') {
  global.structuredClone = (obj) => {
    return JSON.parse(JSON.stringify(obj));
  };
}

// Mock expo-router
jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
  useRouter: jest.fn(() => ({
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  })),
}));

// Mock expo-constants
jest.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      scheme: 'exampleapp',
      slug: 'exampleapp',
      extra: {
        eas: {
          projectId: '00000000-0000-0000-0000-000000000000',
        },
      },
    },
  },
}));

// Mock Better Auth completely
jest.mock('better-auth/react', () => ({
  createAuthClient: jest.fn(() => ({
    emailOtp: {
      sendVerificationOtp: jest.fn(),
      verifyEmail: jest.fn(),
    },
    getSession: jest.fn(),
    getCookie: jest.fn(() => 'mock-cookie'),
    useSession: jest.fn(),
  })),
}));

jest.mock('@better-auth/expo/client', () => ({
  expoClient: jest.fn(() => ({})),
}));

jest.mock('better-auth/client/plugins', () => ({
  emailOTPClient: jest.fn(() => ({})),
  jwtClient: jest.fn(() => ({})),
}));

// Mock expo-device. `osVersion` matters beyond telemetry — translation-service
// gates Apple's per-language on-device translation on the iOS major, so leaving
// it undefined silently changes what every translation test asserts.
jest.mock('expo-device', () => ({
  isDevice: true,
  osVersion: '18.0',
}));

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// Mock @react-native-async-storage/async-storage
const mockAsyncStorage = {
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: mockAsyncStorage,
}));

// Export for test access
global.mockAsyncStorage = mockAsyncStorage;

// Mock expo-notifications
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(() =>
    Promise.resolve({ data: 'ExponentPushToken[test-token]' })
  ),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('notification-id')),
  cancelAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve()),
  getAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve([])),
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  setBadgeCountAsync: jest.fn(() => Promise.resolve()),
  getBadgeCountAsync: jest.fn(() => Promise.resolve(0)),
  addNotificationReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  AndroidImportance: {
    MAX: 5,
  },
}));

// Mock react-native Platform. Includes `default` so `import { Platform } from
// 'react-native'` (which reads the module's default export) resolves — without
// it, named Platform is undefined and Platform.select throws.
jest.mock('react-native/Libraries/Utilities/Platform', () => {
  const platform = { OS: 'ios', select: jest.fn((obj) => obj.ios ?? obj.default) };
  return { __esModule: true, ...platform, default: platform };
});

// --- Global native-dep safety nets (plan Phase 0) ---------------------------
// These keep a stray transitive import from crashing a test. Individual test
// files still override these with scripted behaviour where they assert on it.

// Expo's whatwg fetch used by the cloud LLM transport.
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// llama.rn — native on-device inference binding. Never load the real one.
// Revalidated against 0.12.9. It must cover everything modelManager.ts
// imports, not just the two obvious entry points: an explicit factory that
// omits an export makes it `undefined` at the call site, and the resulting
// TypeError gets swallowed by whatever try/catch is nearest and reads as
// "the model never loaded" rather than as a missing mock.
jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
  releaseAllLlama: jest.fn(),
  loadLlamaModelInfo: jest.fn(() => Promise.resolve({})),
  toggleNativeLog: jest.fn(),
  addNativeLogListener: jest.fn(() => ({ remove: jest.fn() })),
}));

// react-native-fs — model download / filesystem access.
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/mera-test',
  CachesDirectoryPath: '/tmp/mera-test-cache',
  exists: jest.fn(() => Promise.resolve(false)),
  mkdir: jest.fn(() => Promise.resolve()),
  unlink: jest.fn(() => Promise.resolve()),
  stat: jest.fn(() => Promise.resolve({ size: 0 })),
  downloadFile: jest.fn(() => ({
    jobId: 1,
    promise: Promise.resolve({ statusCode: 200, bytesWritten: 0 }),
  })),
  stopDownload: jest.fn(),
}));

// Background task registrars.
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(() => Promise.resolve(false)),
  unregisterTaskAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(() => Promise.resolve()),
  unregisterTaskAsync: jest.fn(() => Promise.resolve()),
  getStatusAsync: jest.fn(() => Promise.resolve(1)),
  BackgroundTaskStatus: { Available: 1, Restricted: 2 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));

// Network connectivity.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(() => Promise.resolve({ isConnected: true, isInternetReachable: true })),
    addEventListener: jest.fn(() => jest.fn()),
  },
  fetch: jest.fn(() => Promise.resolve({ isConnected: true, isInternetReachable: true })),
  addEventListener: jest.fn(() => jest.fn()),
}));

// Misc expo modules used across services.
jest.mock('expo-crypto', () => ({
  getRandomBytes: jest.fn((n) => new Uint8Array(n)),
  getRandomBytesAsync: jest.fn((n) => Promise.resolve(new Uint8Array(n))),
  randomUUID: jest.fn(() => '00000000-0000-0000-0000-000000000000'),
  digestStringAsync: jest.fn(() => Promise.resolve('deadbeef')),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
  getStringAsync: jest.fn(() => Promise.resolve('')),
}));
jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [
    { languageCode: 'en', regionCode: 'US', languageTag: 'en-US' },
  ]),
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve({ type: 'opened' })),
  dismissBrowser: jest.fn(),
  WebBrowserPresentationStyle: { AUTOMATIC: 'automatic' },
}));
// Keep this surface a SUPERSET of every Sentry API the app calls. The mock is
// global, so a missing key surfaces as `undefined is not a function` in the
// ~132 suites that transitively import lib/logger.ts — far from the code that
// actually added the call.
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureFeedback: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  setTags: jest.fn(),
  setContext: jest.fn(),
  setExtra: jest.fn(),
  setExtras: jest.fn(),
  withScope: jest.fn((cb) =>
    cb({
      setTag: jest.fn(),
      setExtra: jest.fn(),
      setContext: jest.fn(),
      setLevel: jest.fn(),
    }),
  ),
  getCurrentScope: jest.fn(() => ({
    setTag: jest.fn(),
    setExtra: jest.fn(),
    setContext: jest.fn(),
    setUser: jest.fn(),
  })),
  startInactiveSpan: jest.fn(() => ({ end: jest.fn(), setStatus: jest.fn() })),
  wrap: jest.fn((c) => c),
  feedbackIntegration: jest.fn(() => ({})),
  reactNavigationIntegration: jest.fn(() => ({})),
  Severity: { Error: 'error', Warning: 'warning' },
}));

// Spinner. React Native's own jest mock for ActivityIndicator does a
// `requireActual` on src/private/specs_DEPRECATED/ActivityIndicatorViewNativeComponent,
// which is untransformed ESM and dies with "Unexpected token 'export'". Nothing
// rendered a Spinner in a test until the support row got one, so the whole
// suite for a screen fell over on an import rather than on anything it asserts.
//
// Global rather than per-suite: the failure has nothing to do with any one
// screen, it is a property of the primitive, and the next person to put a
// spinner in a component should not have to rediscover this. Purely
// presentational, so a stub costs no assertion.
//
// NO JSX IN THIS FILE. babel-preset-expo routes JSX through
// react-native-css-interop's jsx-runtime, so a single JSX element here imports
// css-interop into EVERY suite at setup time. That broke
// web-browser-utils-android.test.ts, which mocks react-native and does not
// render anything. Returning the component directly avoids the whole question.
jest.mock('@/components/ui/spinner', () => {
  const { View } = require('react-native');
  return { Spinner: View };
});

// Intercom — native support Messenger. An explicit factory, NOT an automock:
// lib/auth-client.ts imports lib/intercom.ts statically (logoutIntercom runs
// inside clearAuthStorage), so the package is pulled into every auth suite, and
// the real module dereferences native TurboModule state at import time. The
// enums are exported because the module's type surface references them.
jest.mock('@intercom/intercom-react-native', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(() => Promise.resolve(true)),
    setUserJwt: jest.fn(() => Promise.resolve(true)),
    loginUserWithUserAttributes: jest.fn(() => Promise.resolve(true)),
    loginUnidentifiedUser: jest.fn(() => Promise.resolve(true)),
    // Defaults to NOT logged in so presentIntercomMessenger() exercises its
    // login branch. A mock defaulting to `true` would skip that path and make
    // the login-ordering tests pass without ever calling login.
    isUserLoggedIn: jest.fn(() => Promise.resolve(false)),
    logout: jest.fn(() => Promise.resolve(true)),
    present: jest.fn(() => Promise.resolve(true)),
    presentSpace: jest.fn(() => Promise.resolve(true)),
    sendTokenToIntercom: jest.fn(() => Promise.resolve(true)),
    getUnreadConversationCount: jest.fn(() => Promise.resolve(0)),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Space: { home: 'HOME', helpCenter: 'HELP_CENTER', messages: 'MESSAGES', tickets: 'TICKETS' },
  Visibility: { VISIBLE: 'VISIBLE', GONE: 'GONE' },
  LogLevel: { ASSERT: 'ASSERT', DEBUG: 'DEBUG', ERROR: 'ERROR', INFO: 'INFO', VERBOSE: 'VERBOSE', WARN: 'WARN' },
  ThemeMode: { LIGHT: 'LIGHT', DARK: 'DARK', SYSTEM: 'SYSTEM' },
  IntercomEvents: { IntercomUnreadCountDidChange: 'IntercomUnreadCountDidChange' },
}));

// RevenueCat — native IAP SDK + paywall UI. Never load the real modules (they
// pull in ESM deps Jest can't transform). Individual tests override behaviour.
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    setLogLevel: jest.fn(),
    logIn: jest.fn(() =>
      Promise.resolve({
        customerInfo: { entitlements: { active: {} } },
        created: false,
      }),
    ),
    logOut: jest.fn(() => Promise.resolve({ entitlements: { active: {} } })),
    // Defaults to an IDENTIFIED customer: `logoutRevenueCat()` short-circuits
    // when anonymous, so a mock missing this would make every logout test pass
    // for the wrong reason — the call throwing and being swallowed.
    isAnonymous: jest.fn(() => Promise.resolve(false)),
    getCustomerInfo: jest.fn(() =>
      Promise.resolve({ entitlements: { active: {} } }),
    ),
    getOfferings: jest.fn(() =>
      Promise.resolve({ current: null, all: {} }),
    ),
    addCustomerInfoUpdateListener: jest.fn(),
    removeCustomerInfoUpdateListener: jest.fn(),
    // Subscriber attributes. `setAttributes` is write-only from the SDK, so
    // tests assert on the mock's call args — that is the only way to check what
    // we send. Never add setEmail/setPhoneNumber/setDisplayName/
    // collectDeviceIdentifiers here: they are not called by design, and a mock
    // for them would make an accidental future call silently pass.
    setAttributes: jest.fn(),
    syncAttributesAndOfferingsIfNeeded: jest.fn(() =>
      Promise.resolve({ current: null, all: {} }),
    ),
    getAppUserID: jest.fn(() => Promise.resolve('test-user-id')),
  },
  LOG_LEVEL: {
    VERBOSE: 'VERBOSE',
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
  },
  // Real values from the SDK's enum. Needed because the price label is gated
  // on `pkg.packageType === PACKAGE_TYPE.MONTHLY`; without this the namespace
  // is `undefined` and the comparison throws rather than failing an assertion.
  PACKAGE_TYPE: {
    UNKNOWN: 'UNKNOWN',
    CUSTOM: 'CUSTOM',
    LIFETIME: 'LIFETIME',
    ANNUAL: 'ANNUAL',
    SIX_MONTH: 'SIX_MONTH',
    THREE_MONTH: 'THREE_MONTH',
    TWO_MONTH: 'TWO_MONTH',
    MONTHLY: 'MONTHLY',
    WEEKLY: 'WEEKLY',
  },
}));
jest.mock('react-native-purchases-ui', () => ({
  __esModule: true,
  default: {
    presentPaywall: jest.fn(() => Promise.resolve('NOT_PRESENTED')),
    presentPaywallIfNeeded: jest.fn(() => Promise.resolve('NOT_PRESENTED')),
    presentCustomerCenter: jest.fn(() => Promise.resolve()),
  },
  PAYWALL_RESULT: {
    NOT_PRESENTED: 'NOT_PRESENTED',
    ERROR: 'ERROR',
    CANCELLED: 'CANCELLED',
    PURCHASED: 'PURCHASED',
    RESTORED: 'RESTORED',
  },
}));

// --- Deps banked for the next binary -------------------------------------
// These three native modules ship in the store build so the features that use
// them (tutorial/processing animations, the reading-stats share card) can go
// out over the air later. Nothing imports them yet; the mocks exist so the
// first consumer does not also have to fix the test setup.

// lottie-react-native — native animation view. NO JSX in this file:
// babel-preset-expo routes JSX through react-native-css-interop's runtime,
// which then loads into EVERY suite at setup time. Hand back the RN primitive.
jest.mock('lottie-react-native', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View };
});

// react-native-view-shot — native view capture. Default export is a component;
// the three capture helpers are named exports.
jest.mock('react-native-view-shot', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: View,
    captureRef: jest.fn(() => Promise.resolve('file:///tmp/mera-capture.png')),
    captureScreen: jest.fn(() => Promise.resolve('file:///tmp/mera-capture.png')),
    releaseCapture: jest.fn(),
  };
});

// expo-sharing — hands a captured file to the OS share sheet. Only the runtime
// module is used; its config plugin builds an inbound share EXTENSION and is
// deliberately not registered in app.json.
jest.mock('expo-sharing', () => ({
  __esModule: true,
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  shareAsync: jest.fn(() => Promise.resolve()),
}));

// --- Backup & restore native modules ------------------------------------
// react-native-cloud-storage resolves TWO TurboModules at MODULE scope
// (`CloudStorageCloudKit`, `CloudStorageLocalFileSystem`). Under Jest those
// resolve to null, so anything that transitively imports `lib/backup/**` gets a
// null native handle rather than a clear error. Mock the public surface instead
// — otherwise the breakage lands in suites that have nothing to do with backup.
// The real export is a CLASS with static mirrors of every instance method, and
// lib/backup/providers/* constructs its own instance per provider (a shared
// static default would mean configuring Drive reconfigured iCloud). So the mock
// has to be a class too — an object literal passes `CloudStorage.readdir(...)`
// and throws "not a constructor" on `new CloudStorage(...)`.
jest.mock('react-native-cloud-storage', () => {
  const methods = {
    isCloudAvailable: () => Promise.resolve(true),
    exists: () => Promise.resolve(false),
    readFile: () => Promise.resolve(''),
    writeFile: () => Promise.resolve(),
    appendFile: () => Promise.resolve(),
    uploadFile: () => Promise.resolve(),
    downloadFile: () => Promise.resolve(),
    unlink: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    rmdir: () => Promise.resolve(),
    readdir: () => Promise.resolve([]),
    stat: () => Promise.resolve({ size: 0 }),
    triggerSync: () => Promise.resolve(),
    getProvider: () => 'ICloud',
    setProvider: () => undefined,
    getProviderOptions: () => ({}),
    setProviderOptions: () => undefined,
    subscribeToCloudAvailability: () => undefined,
    unsubscribeFromCloudAvailability: () => undefined,
  };
  class CloudStorage {
    constructor() {
      for (const [name, impl] of Object.entries(methods)) this[name] = jest.fn(impl);
    }
  }
  for (const [name, impl] of Object.entries(methods)) CloudStorage[name] = jest.fn(impl);
  CloudStorage.getDefaultInstance = jest.fn(() => new CloudStorage());
  CloudStorage.getDefaultProvider = jest.fn(() => 'ICloud');
  CloudStorage.getSupportedProviders = jest.fn(() => ['ICloud', 'GoogleDrive']);

  return {
    __esModule: true,
    CloudStorage,
    CloudStorageScope: { AppData: 'app_data', Documents: 'documents' },
    CloudStorageProvider: { ICloud: 'icloud', GoogleDrive: 'googledrive' },
    CloudStorageError: class CloudStorageError extends Error {},
    CloudStorageErrorCode: {
      FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',
      DIRECTORY_NOT_FOUND: 'ERR_DIRECTORY_NOT_FOUND',
      FILE_ALREADY_EXISTS: 'ERR_FILE_EXISTS',
    },
  };
});

// @react-native-google-signin/google-signin ships no jest mock of its own
// (only a `build` dir), so this is hand-written. GoogleSigninButton is a
// component: no JSX here, hand back the RN primitive.
jest.mock('@react-native-google-signin/google-signin', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    GoogleSignin: {
      configure: jest.fn(),
      hasPlayServices: jest.fn(() => Promise.resolve(true)),
      signIn: jest.fn(() => Promise.resolve({ type: 'cancelled' })),
      signInSilently: jest.fn(() => Promise.resolve({ type: 'noSavedCredentialFound' })),
      hasPreviousSignIn: jest.fn(() => false),
      signOut: jest.fn(() => Promise.resolve()),
      revokeAccess: jest.fn(() => Promise.resolve()),
      getCurrentUser: jest.fn(() => null),
      getTokens: jest.fn(() => Promise.resolve({ accessToken: 'test-access-token' })),
    },
    GoogleSigninButton: View,
    statusCodes: {
      SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
      IN_PROGRESS: 'IN_PROGRESS',
      PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
    },
  };
});

// Silence console errors during tests
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
};
