// Guards for the four failure modes review caught in lib/intercom.ts. Each
// describe block below maps to one of them; none is a hypothetical.

const mockQuery = jest.fn();
jest.mock('@/lib/apollo-client', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => mockQuery(...args) },
}));

const mockCaptureException = jest.fn();
const mockWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...a: any[]) => mockCaptureException(...a),
    warn: (...a: any[]) => mockWarn(...a),
  },
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: { getState: () => ({ userId: 'user-1', userEmail: 'a@b.test' }) },
}));

// Support-id plumbing: the real mailto builder (that IS the behavior under
// test), a controllable fetch. Mocked wholesale rather than requireActual —
// the real module imports auth-client, whose expo secure-store sync API is not
// available in this suite.
const mockGetSupportId = jest.fn(async (..._a: unknown[]): Promise<string | null> => null);
const mockIsOnline = jest.fn(() => true);
jest.mock('@/lib/support-id', () => ({
  getSupportId: (...a: unknown[]) => mockGetSupportId(...a),
  buildSupportMailtoUrl: (email: string, id: string | null) =>
    id ? `mailto:${email}?body=${encodeURIComponent(`Support ID: ${id}\n\n`)}` : `mailto:${email}`,
}));
jest.mock('@/lib/stores/network-store', () => ({
  isOnline: () => mockIsOnline(),
}));

// A MUTABLE mock object, not a per-test jest.doMock. doMock is not scoped to
// the test that calls it: it re-registers the module for every subsequent
// require in the file, so one "no key configured" test silently disabled
// Intercom for every test after it. The logout-race tests then passed for the
// wrong reason — they assert `false`, which is also what an unconfigured
// module returns before it does any work at all.
const mockEndpoints = {
  INTERCOM_APP_ID: '',
  INTERCOM_IOS_KEY: '',
  INTERCOM_ANDROID_KEY: '',
};
jest.mock('@/lib/config/endpoints', () => mockEndpoints);

function configureKeys() {
  mockEndpoints.INTERCOM_APP_ID = 'app123';
  mockEndpoints.INTERCOM_IOS_KEY =
    'ios_sdk-0123456789012345678901234567890123456789';
  mockEndpoints.INTERCOM_ANDROID_KEY =
    'android_sdk-0123456789012345678901234567890123456789';
}

// jest.resetModules() re-runs the jest.setup.js mock factory, so each load
// produces a DIFFERENT mock object. Binding `native` once at import time would
// leave every assertion pointed at an abandoned instance that the module under
// test never calls — which fails as "0 calls" and reads like a broken
// implementation. Re-bind on every load instead.
let native: Record<string, jest.Mock>;

function loadModule() {
  const mod = require('../intercom');
  native = require('@intercom/intercom-react-native')
    .default as unknown as Record<string, jest.Mock>;
  native.initialize.mockResolvedValue(true);
  native.setUserJwt.mockResolvedValue(true);
  native.loginUserWithUserAttributes.mockResolvedValue(true);
  native.isUserLoggedIn.mockResolvedValue(false);
  native.logout.mockResolvedValue(true);
  native.present.mockResolvedValue(true);
  return mod;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  configureKeys();
  mockIsOnline.mockReturnValue(true);
  mockGetSupportId.mockResolvedValue(null);
  mockQuery.mockResolvedValue({
    data: { intercomIdentity: { jwt: 'jwt-1', expiresAt: '2026-01-01' } },
  });
});

// BLOCKER A. `configured` only flips when initialize() resolves, and initialize
// only runs inside presentIntercomMessenger(). If the UI gated on `configured`,
// the first tap would read false, take the mailto path, and never initialise —
// forever, looking exactly like the intended no-credentials degradation.
describe('the UI gate is bundle-time, not init-time', () => {
  it('isIntercomEnabled() is true before any initialize call', () => {
    const m = loadModule();
    expect(m.isIntercomEnabled()).toBe(true);
    expect(m.isIntercomConfigured()).toBe(false);
    expect(native.initialize).not.toHaveBeenCalled();
  });

  it('a first present() initialises and succeeds rather than falling back', async () => {
    const m = loadModule();
    await expect(m.presentIntercomMessenger()).resolves.toBe(true);
    expect(native.initialize).toHaveBeenCalledTimes(1);
    expect(native.present).toHaveBeenCalledTimes(1);
  });

  it('is false when the app id is absent even though a platform key is set', () => {
    mockEndpoints.INTERCOM_APP_ID = '';
    expect(loadModule().isIntercomEnabled()).toBe(false);
  });

  it('present() no-ops without touching the SDK when no key is configured', async () => {
    mockEndpoints.INTERCOM_APP_ID = '';
    mockEndpoints.INTERCOM_IOS_KEY = '';
    const m = loadModule();
    await expect(m.presentIntercomMessenger()).resolves.toBe(false);
    expect(native.initialize).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// BLOCKER B. Intercom.logout() rejects when the SDK was never initialised,
// which lazy init makes the common case. clearAuthStorage() awaits it
// unguarded inside the logout handler's try, so a rejection here would skip
// wipeAllLocalUserData() and strand the device with no cookie but a live
// cached_user_id.
describe('logoutIntercom is total', () => {
  it('resolves without touching the SDK when never initialised', async () => {
    const m = loadModule();
    await expect(m.logoutIntercom()).resolves.toBeUndefined();
    expect(native.logout).not.toHaveBeenCalled();
  });

  it('resolves even when the native logout rejects', async () => {
    const m = loadModule();
    await m.configureIntercom();
    native.logout.mockRejectedValue(new Error('not initialised'));
    await expect(m.logoutIntercom()).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });
});

// BLOCKER D. A logout landing between the identity fetch and the login call
// would re-establish the DEPARTED user's Intercom session after sign-out.
// Intercom holds identity natively, so that session would survive into the next
// user on the same device.
describe('a logout mid-present is abandoned', () => {
  it('does not log in when logout lands during the JWT fetch', async () => {
    const m = loadModule();
    await m.configureIntercom();
    mockQuery.mockImplementation(async () => {
      await m.logoutIntercom();
      return { data: { intercomIdentity: { jwt: 'jwt-1', expiresAt: 'x' } } };
    });
    await expect(m.presentIntercomMessenger()).resolves.toBe(false);
    expect(native.loginUserWithUserAttributes).not.toHaveBeenCalled();
    expect(native.present).not.toHaveBeenCalled();
  });

  it('does not present when logout lands during login', async () => {
    const m = loadModule();
    await m.configureIntercom();
    native.loginUserWithUserAttributes.mockImplementation(async () => {
      await m.logoutIntercom();
      return true;
    });
    await expect(m.presentIntercomMessenger()).resolves.toBe(false);
    expect(native.present).not.toHaveBeenCalled();
  });
});

// The JWT is validated by Intercom on every request and lives about an hour, so
// a mint-once-at-login design works in testing and dies mid-conversation.
describe('identity is refreshed on every present', () => {
  it('re-mints and re-sets the JWT on the second present', async () => {
    const m = loadModule();
    await m.presentIntercomMessenger();
    native.isUserLoggedIn.mockResolvedValue(true);
    await m.presentIntercomMessenger();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(native.setUserJwt).toHaveBeenCalledTimes(2);
    // Second tap refreshes the token but must not re-run a full login.
    expect(native.loginUserWithUserAttributes).toHaveBeenCalledTimes(1);
  });

  it('sets the JWT before calling login, never after', async () => {
    const order: string[] = [];
    const m = loadModule();
    native.setUserJwt.mockImplementation(async () => {
      order.push('jwt');
      return true;
    });
    native.loginUserWithUserAttributes.mockImplementation(async () => {
      order.push('login');
      return true;
    });
    await m.presentIntercomMessenger();
    expect(order).toEqual(['jwt', 'login']);
  });

  it('sends userId and email and nothing else', async () => {
    const m = loadModule();
    await m.presentIntercomMessenger();
    expect(native.loginUserWithUserAttributes).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'a@b.test',
    });
  });
});

describe('every failure degrades to the mailto fallback', () => {
  it('returns false when initialize rejects, and retries on the next tap', async () => {
    const m = loadModule();
    native.initialize.mockRejectedValueOnce(new Error('bad key'));
    await expect(m.presentIntercomMessenger()).resolves.toBe(false);
    expect(mockCaptureException).toHaveBeenCalled();
    // The poisoned promise must be cleared, or one bad network moment would
    // disable support for the rest of the process lifetime.
    await expect(m.presentIntercomMessenger()).resolves.toBe(true);
  });

  it('returns false when the identity query fails', async () => {
    const m = loadModule();
    mockQuery.mockRejectedValue(new Error('no such query'));
    await expect(m.presentIntercomMessenger()).resolves.toBe(false);
    expect(native.present).not.toHaveBeenCalled();
  });

  it('opts the identity query out of the feed-wide sync-failed banner', async () => {
    const m = loadModule();
    await m.presentIntercomMessenger();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ context: { noSyncStatus: true } }),
    );
  });

  it('never rejects, whatever the SDK does', async () => {
    const m = loadModule();
    native.present.mockRejectedValue(new Error('boom'));
    await expect(m.presentIntercomMessenger()).resolves.toBe(false);
  });
});

// S5: the support id rides every support surface automatically.
// Required at module scope: RNTL registers its cleanup hooks on import, which
// jest-circus forbids inside a test body. The module under test is ALSO
// captured at module scope for the hook tests: loadModule() runs after
// jest.resetModules(), which would hand the hook a SECOND React copy and a
// null dispatcher under RNTL's renderer. Config and collaborators are read at
// call time, so the top-level instance sees the same mutable mocks.
const { renderHook, act } = require('@testing-library/react-native');
const intercomTop = require('../intercom') as typeof import('../intercom');

// react-native exposes Linking through a LAZY GETTER, so after the
// jest.resetModules() in beforeEach the module under test reaches a FRESH
// Linking instance — the spy must be installed per test, post-reset, on
// require('react-native').Linking, never on a top-level capture.
function spyOnOpenURL() {
  const { Linking } = require('react-native');
  return jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
}

describe('support id autofill', () => {
  it('Intercom login carries support_id as a custom attribute when known', async () => {
    mockGetSupportId.mockResolvedValue('12345678');
    const m = loadModule();
    await expect(m.presentIntercomMessenger()).resolves.toBe(true);
    expect(native.loginUserWithUserAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        customAttributes: { support_id: '12345678' },
      }),
    );
  });

  it('Intercom login omits the attribute entirely when the id is unknown', async () => {
    const m = loadModule();
    await expect(m.presentIntercomMessenger()).resolves.toBe(true);
    const args = native.loginUserWithUserAttributes.mock.calls[0][0];
    expect(args).not.toHaveProperty('customAttributes');
  });

  it('the mailto fallback body carries the Support ID line', async () => {
    const openURL = spyOnOpenURL();
    try {
      // No Intercom keys -> the hook takes the mailto path directly.
      mockEndpoints.INTERCOM_APP_ID = '';
      mockEndpoints.INTERCOM_IOS_KEY = '';
      mockEndpoints.INTERCOM_ANDROID_KEY = '';
      mockGetSupportId.mockResolvedValue('12345678');

      const onMailFailed = jest.fn();
      const { result } = renderHook(() => intercomTop.useSupportAction(onMailFailed));
      await act(async () => {
        await result.current.openSupport();
      });

      expect(onMailFailed).not.toHaveBeenCalled();
      expect(mockGetSupportId).toHaveBeenCalledTimes(1);
      expect(openURL).toHaveBeenCalledTimes(1);
      const url = String(openURL.mock.calls[0][0]);
      expect(url.startsWith('mailto:')).toBe(true);
      expect(decodeURIComponent(url)).toContain('Support ID: 12345678');
    } finally {
      openURL.mockRestore();
    }
  });

  it('offline mailto opens immediately with no id fetch (bare mailto)', async () => {
    const openURL = spyOnOpenURL();
    try {
      mockEndpoints.INTERCOM_APP_ID = '';
      mockIsOnline.mockReturnValue(false);

      const { result } = renderHook(() => intercomTop.useSupportAction());
      await act(async () => {
        await result.current.openSupport();
      });

      expect(mockGetSupportId).not.toHaveBeenCalled();
      const url = String(openURL.mock.calls[0][0]);
      expect(url).toMatch(/^mailto:[^?]+$/);
    } finally {
      openURL.mockRestore();
    }
  });
});
