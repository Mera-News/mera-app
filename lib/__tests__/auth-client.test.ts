// auth-client.ts creates an authClient at import time from better-auth.
// We must mock all deps before the import.
//
// jest.mock() is hoisted before variable declarations, so the factory must NOT
// directly reference variables defined outside (they would be in the TDZ at
// factory run time). All mock functions are created INSIDE the factory and
// retrieved via require() after the import.

jest.mock('better-auth/react', () => ({
  createAuthClient: jest.fn(() => ({
    emailOtp: { sendVerificationOtp: jest.fn() },
    getSession: jest.fn(),
    token: jest.fn(),
    signOut: jest.fn(),
  })),
}));

jest.mock('@better-auth/expo/client', () => ({
  expoClient: jest.fn(() => ({})),
}));

jest.mock('better-auth/client/plugins', () => ({
  emailOTPClient: jest.fn(() => ({})),
  jwtClient: jest.fn(() => ({})),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  setItem: jest.fn(),
  getItem: jest.fn(() => null),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('../config/endpoints', () => ({
  AUTH_ENDPOINT: 'https://auth.test',
  INFERENCE_ENDPOINT: 'https://inference.test',
  GRAPHQL_SERVER_ENDPOINT: 'https://api.test',
  DUMP_QUERIES_ENABLED: false,
}));

import { sendOTP, getJwtToken, invalidateJwtCache, clearAuthStorage } from '../auth-client';

// Grab mock fn references via require() — same module cache that auth-client uses
// internally, guaranteeing we reference the EXACT same jest.fn() instances.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAuthClient } = require('better-auth/react');
// authClient is the singleton returned by createAuthClient(...). Because
// createAuthClient is called at module import time, the call record is already
// in mock.calls[0] when we arrive here.
const mockAuthClient = createAuthClient.mock.results[0]?.value ?? createAuthClient();
const mockSendVerificationOtp: jest.Mock = mockAuthClient.emailOtp.sendVerificationOtp;
const mockGetSession: jest.Mock = mockAuthClient.getSession;
const mockToken: jest.Mock = mockAuthClient.token;
const mockSignOut: jest.Mock = mockAuthClient.signOut;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockDeleteItemAsync: jest.Mock = require('expo-secure-store').deleteItemAsync;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockLoggerCaptureException: jest.Mock = require('../logger').default.captureException;

describe('sendOTP', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns { success: true } on successful OTP send', async () => {
    mockSendVerificationOtp.mockResolvedValueOnce({ error: null });
    const result = await sendOTP('user@example.com');
    expect(result).toEqual({ success: true });
    expect(mockSendVerificationOtp).toHaveBeenCalledWith({
      email: 'user@example.com',
      type: 'sign-in',
    });
  });

  it('returns { success: false, error } when server returns an error', async () => {
    mockSendVerificationOtp.mockResolvedValueOnce({
      error: { message: 'Too many attempts' },
    });
    const result = await sendOTP('user@example.com');
    expect(result).toEqual({ success: false, error: 'Too many attempts' });
  });

  it('returns { success: false, error: "Failed to send OTP" } when error has no message', async () => {
    mockSendVerificationOtp.mockResolvedValueOnce({ error: {} });
    const result = await sendOTP('user@example.com');
    expect(result).toEqual({ success: false, error: 'Failed to send OTP' });
  });

  it('returns { success: false, error } when the promise rejects', async () => {
    mockSendVerificationOtp.mockRejectedValueOnce(new Error('Network error'));
    const result = await sendOTP('user@example.com');
    expect(result).toEqual({ success: false, error: 'Network error' });
  });

  it('returns { success: false, error: "Failed to send OTP" } for non-Error throws', async () => {
    mockSendVerificationOtp.mockRejectedValueOnce({ message: undefined });
    const result = await sendOTP('user@example.com');
    expect(result.success).toBe(false);
  });
});

describe('getJwtToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateJwtCache();
  });

  it('returns null when there is no active session', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null });
    const token = await getJwtToken();
    expect(token).toBeNull();
  });

  it('returns null when session.data.session is absent', async () => {
    mockGetSession.mockResolvedValueOnce({ data: {} });
    const token = await getJwtToken();
    expect(token).toBeNull();
  });

  it('returns null when authClient.token() returns error', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    mockToken.mockResolvedValueOnce({ error: { message: 'Unauthorized' }, data: null });
    const token = await getJwtToken();
    expect(token).toBeNull();
  });

  it('returns the JWT token on success', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    mockToken.mockResolvedValueOnce({ error: null, data: { token: 'jwt-abc' } });
    const token = await getJwtToken();
    expect(token).toBe('jwt-abc');
  });

  it('returns cached JWT on second call within TTL', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { id: 's1' } } });
    mockToken.mockResolvedValue({ error: null, data: { token: 'jwt-cached' } });

    const first = await getJwtToken();
    const second = await getJwtToken();

    expect(first).toBe('jwt-cached');
    expect(second).toBe('jwt-cached');
    // authClient.getSession should only be called once (cache hit on second)
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent requests (only one real auth call)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { id: 's1' } } });
    mockToken.mockResolvedValue({ error: null, data: { token: 'jwt-deduped' } });

    // Fire two concurrent calls before cache is populated
    const [a, b] = await Promise.all([getJwtToken(), getJwtToken()]);
    expect(a).toBe('jwt-deduped');
    expect(b).toBe('jwt-deduped');
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('returns null and logs when an exception is thrown', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('Auth network failure'));
    const token = await getJwtToken();
    expect(token).toBeNull();
    expect(mockLoggerCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { service: 'auth-client', method: 'getJwtToken' } }),
    );
  });
});

describe('invalidateJwtCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forces a fresh fetch on next getJwtToken call', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { id: 's1' } } });
    mockToken.mockResolvedValue({ error: null, data: { token: 'fresh-jwt' } });

    await getJwtToken(); // populate cache
    invalidateJwtCache();
    await getJwtToken(); // should re-fetch

    expect(mockGetSession).toHaveBeenCalledTimes(2);
  });
});

describe('clearAuthStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateJwtCache();
  });

  it('calls authClient.signOut', async () => {
    mockSignOut.mockResolvedValueOnce(undefined);
    await clearAuthStorage();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('deletes _cookie and _session_data keys from secure store', async () => {
    mockSignOut.mockResolvedValueOnce(undefined);
    await clearAuthStorage();
    // secureStore.deleteItemAsync passes a keychainAccessible options object as
    // the second argument. Match only on the key string (first arg).
    expect(mockDeleteItemAsync).toHaveBeenCalledWith(
      expect.stringContaining('_cookie'),
      expect.anything(),
    );
    expect(mockDeleteItemAsync).toHaveBeenCalledWith(
      expect.stringContaining('_session_data'),
      expect.anything(),
    );
  });

  it('invalidates the JWT cache as part of clearAuthStorage', async () => {
    // Populate cache first
    mockGetSession.mockResolvedValue({ data: { session: { id: 's1' } } });
    mockToken.mockResolvedValue({ error: null, data: { token: 'pre-clear' } });
    await getJwtToken();

    mockSignOut.mockResolvedValueOnce(undefined);
    await clearAuthStorage();

    // After clearing, the cache should be empty — next call re-fetches
    mockGetSession.mockResolvedValueOnce({ data: null });
    const token = await getJwtToken();
    expect(token).toBeNull();
  });

  it('does not throw even if signOut rejects', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('Already signed out'));
    await expect(clearAuthStorage()).resolves.not.toThrow();
  });

  it('does not throw even if deleteItemAsync rejects', async () => {
    mockSignOut.mockResolvedValueOnce(undefined);
    mockDeleteItemAsync.mockRejectedValue(new Error('key not found'));
    await expect(clearAuthStorage()).resolves.not.toThrow();
  });
});
