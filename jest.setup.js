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

// Native-edge mocks shared with the integration project.
require('./jest.setup.native.js');

// --- Legacy-only mocks -------------------------------------------------------
// The integration project replaces each of these with something stateful or real.

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

// Expo's whatwg fetch used by the cloud LLM transport.
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// Misc expo modules used across services.
jest.mock('expo-crypto', () => ({
  getRandomBytes: jest.fn((n) => new Uint8Array(n)),
  getRandomBytesAsync: jest.fn((n) => Promise.resolve(new Uint8Array(n))),
  randomUUID: jest.fn(() => '00000000-0000-0000-0000-000000000000'),
  digestStringAsync: jest.fn(() => Promise.resolve('deadbeef')),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
}));

// Silence console errors during tests
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
};
