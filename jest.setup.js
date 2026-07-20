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

// Mock expo-device
jest.mock('expo-device', () => ({
  isDevice: true,
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
jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
  releaseAllLlama: jest.fn(),
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
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  setContext: jest.fn(),
  wrap: jest.fn((c) => c),
  reactNavigationIntegration: jest.fn(() => ({})),
  Severity: { Error: 'error', Warning: 'warning' },
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
    getCustomerInfo: jest.fn(() =>
      Promise.resolve({ entitlements: { active: {} } }),
    ),
    getOfferings: jest.fn(() =>
      Promise.resolve({ current: null, all: {} }),
    ),
    addCustomerInfoUpdateListener: jest.fn(),
    removeCustomerInfoUpdateListener: jest.fn(),
  },
  LOG_LEVEL: {
    VERBOSE: 'VERBOSE',
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
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

// Silence console errors during tests
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
};
