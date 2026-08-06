// The real setting-service imports lib/database/index.ts, which instantiates a
// SQLiteAdapter at module load (needs native JSI). launch-route.ts lazy-requires
// both deps, so mocking them here keeps the module graph free of native code.
const mockGetSetting = jest.fn(async (_key: string): Promise<string | null> => null);
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
}));

const mockGetItemAsync = jest.fn(async (_key: string): Promise<string | null> => null);
jest.mock('@/lib/utils/secure-store-adapter', () => ({
  secureStore: { getItemAsync: (key: string) => mockGetItemAsync(key) },
}));

import { hasLocalIdentity, readLocalIdentityState, resolveLaunchRoute } from '../launch-route';

describe('resolveLaunchRoute — cold-start routing matrix', () => {
  it('no identity → /login (first install / logged out)', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: false, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/login');
    // identity is the only gate to /login — the lock state is irrelevant without it.
    expect(
      resolveLaunchRoute({ hasIdentity: false, lockEnabled: true, pinSet: true, locked: true }),
    ).toBe('/login');
  });

  it('identity + lock off → /logged-in, never a setup screen', () => {
    // The default state for a fresh install and for every user who never opted
    // in. The gate must not force PIN setup.
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/logged-in');
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: false, pinSet: false, locked: true }),
    ).toBe('/logged-in');
  });

  it('lock off with a stale PIN record still → /logged-in', () => {
    // A user who set a PIN under the old mandatory flow. pin-store.init clears
    // the record, but the routing decision must not depend on that having run.
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: false, pinSet: true, locked: true }),
    ).toBe('/logged-in');
  });

  it('lock on but no PIN record → /logged-in (never a screen no entry can satisfy)', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: true, pinSet: false, locked: true }),
    ).toBe('/logged-in');
  });

  it('lock on + PIN set + locked → /pin-lock', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: true, pinSet: true, locked: true }),
    ).toBe('/pin-lock');
  });

  it('lock on + PIN set + unlocked → /logged-in', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: true, pinSet: true, locked: false }),
    ).toBe('/logged-in');
  });
});

// hasLocalIdentity() is what feeds `hasIdentity` above, so the two states that
// must NOT be confused with each other are asserted end-to-end here.
describe('hasLocalIdentity — explicit logout vs. dead session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockGetItemAsync.mockResolvedValue(null);
  });

  it('after an explicit logout (no cached_user_id, no cookie) → no identity → /login', async () => {
    // Both identity sources are gone: clearAuthStorage() deleted the cookie and
    // the logout handler deleted `cached_user_id`. Before that delete existed,
    // the surviving settings row kept this true and dropped the signed-out user
    // straight back into the previous user's feed.
    const hasIdentity = await hasLocalIdentity();
    expect(hasIdentity).toBe(false);
    expect(mockGetSetting).toHaveBeenCalledWith('cached_user_id');
    expect(
      resolveLaunchRoute({ hasIdentity, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/login');
  });

  it('session expiry (cached_user_id survives, cookie gone) → still identified → /logged-in', async () => {
    // The regression guard for the offline-first gate: a dead server session
    // must never look like "logged out". The cookie is deliberately absent so
    // this can only pass via the cached-id branch.
    mockGetSetting.mockResolvedValue('user-1');
    mockGetItemAsync.mockResolvedValue(null);

    const hasIdentity = await hasLocalIdentity();
    expect(hasIdentity).toBe(true);
    expect(
      resolveLaunchRoute({ hasIdentity, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/logged-in');
  });

  it('cookie only (fresh login, id not persisted yet) → identified', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockGetItemAsync.mockResolvedValue('cookie-value');

    await expect(hasLocalIdentity()).resolves.toBe(true);
  });

  it('a throwing settings read falls through to the cookie instead of erroring', async () => {
    mockGetSetting.mockRejectedValue(new Error('db unavailable'));
    mockGetItemAsync.mockResolvedValue('cookie-value');

    await expect(hasLocalIdentity()).resolves.toBe(true);
  });
});

// `absent` authorises destroying every byte of local user data, so it must mean
// "both reads completed and found nothing" — never "a read failed". The keychain
// is genuinely unreadable before the device's first post-boot unlock, so this is
// a real state, not a hypothetical one.
describe('readLocalIdentityState — absent vs. unknown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockGetItemAsync.mockResolvedValue(null);
  });

  it('both reads complete and find nothing → absent (the only wipe-authorising state)', async () => {
    await expect(readLocalIdentityState()).resolves.toBe('absent');
  });

  it('cached id present → present', async () => {
    mockGetSetting.mockResolvedValue('user-1');
    await expect(readLocalIdentityState()).resolves.toBe('present');
  });

  it('cookie present → present', async () => {
    mockGetItemAsync.mockResolvedValue('cookie-value');
    await expect(readLocalIdentityState()).resolves.toBe('present');
  });

  it('keychain read THROWS and nothing else found → unknown, never absent', async () => {
    // Cold start before the first device unlock. Treating this as "signed out"
    // would wipe a logged-in user's entire library over a transient failure.
    mockGetItemAsync.mockRejectedValue(new Error('keychain locked'));
    await expect(readLocalIdentityState()).resolves.toBe('unknown');
  });

  it('settings read THROWS and nothing else found → unknown, never absent', async () => {
    mockGetSetting.mockRejectedValue(new Error('db unavailable'));
    await expect(readLocalIdentityState()).resolves.toBe('unknown');
  });

  it('unknown still routes to /login — recoverable by signing in, unlike a wipe', async () => {
    mockGetSetting.mockRejectedValue(new Error('db unavailable'));
    const state = await readLocalIdentityState();
    expect(state).toBe('unknown');
    expect(await hasLocalIdentity()).toBe(false);
    expect(
      resolveLaunchRoute({ hasIdentity: false, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/login');
  });
});
