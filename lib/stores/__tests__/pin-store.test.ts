const mockIsPinSet = jest.fn();
const mockClearPin = jest.fn((..._a: any[]) => Promise.resolve());
const mockIsAppLockEnabled = jest.fn();
const mockSetAppLockEnabled = jest.fn((..._a: any[]) => Promise.resolve());

jest.mock('../../security/pin-service', () => ({
  isPinSet: (...a: any[]) => mockIsPinSet(...a),
  clearPin: (...a: any[]) => mockClearPin(...a),
}));

jest.mock('../../security/app-lock-service', () => ({
  isAppLockEnabled: (...a: any[]) => mockIsAppLockEnabled(...a),
  setAppLockEnabled: (...a: any[]) => mockSetAppLockEnabled(...a),
}));

// The one-shot PIN reset runs inside init(). It owns its own suite
// (security/__tests__/pin-force-reset.test.ts); here it is stubbed so these
// cases still describe init()'s LOCKING logic for a given stored state. Left
// real, it clears the very flags every `lock on` case below sets up.
const mockRunPinForceResetOnce = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../../security/pin-force-reset', () => ({
  // Takes no arguments, so the stub does not spread any — matching the real
  // signature keeps `tsc` honest about the call site.
  runPinForceResetOnce: () => mockRunPinForceResetOnce(),
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), debug: jest.fn(), info: jest.fn(), addBreadcrumb: jest.fn() },
}));

// `lib/app-restart.ts` is left REAL below. That is the point: init() now decides
// the cold-start lock off the restart marker, and the marker is read with
// `getSetting` DIRECTLY because it is read before hydrateAllStores() and a store
// read that early comes back silently empty. Mocking restartContext() would
// prove nothing about that read, and an empty read is the regression these cases
// exist to catch — it would fire the PIN prompt on every single return.
const mockGetSetting = jest.fn();
const mockDeleteSetting = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...a: any[]) => mockGetSetting(...a),
  setSetting: jest.fn(),
  deleteSetting: (...a: any[]) => mockDeleteSetting(...a),
}));

// AppState listener is a side effect of init(); stub addEventListener so it's a
// no-op and doesn't leak between tests.
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

import { RESTART_MARKER_KEY, __resetAppRestartForTests } from '@/lib/app-restart';
import {
  BACKGROUND_LOCK_THRESHOLD_MS,
  shouldLockAfterBackground,
  usePinStore,
} from '../pin-store';

const reset = () =>
  usePinStore.setState({
    pinSet: false,
    lockEnabled: false,
    locked: false,
    lastBackgroundedAt: null,
    initialized: false,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockClearPin.mockResolvedValue(undefined);
  mockSetAppLockEnabled.mockResolvedValue(undefined);
  mockRunPinForceResetOnce.mockResolvedValue(undefined);
  // The restart context memoises its marker read for the life of the module.
  mockGetSetting.mockResolvedValue(null);
  mockDeleteSetting.mockResolvedValue(undefined);
  __resetAppRestartForTests();
  reset();
});

/** A restart marker as `requestRestart` writes it, `awayMs` before now. */
const seedRestartMarker = (awayMs: number | null) => {
  const now = Date.now();
  mockGetSetting.mockImplementation((key: string) =>
    Promise.resolve(
      key === RESTART_MARKER_KEY
        ? JSON.stringify({
            reason: 'foreground',
            at: now,
            backgroundedAt: awayMs == null ? null : now - awayMs,
            lastForegroundAt: null,
          })
        : null,
    ),
  );
};

describe('shouldLockAfterBackground', () => {
  const now = 1_000_000_000;
  const longAgo = now - (BACKGROUND_LOCK_THRESHOLD_MS + 1000);

  it('does not lock when the user has not opted into the lock', () => {
    expect(shouldLockAfterBackground(longAgo, now, true, false)).toBe(false);
  });

  it('does not lock without a PIN', () => {
    expect(shouldLockAfterBackground(longAgo, now, false, true)).toBe(false);
  });

  it('does not lock without a background timestamp', () => {
    expect(shouldLockAfterBackground(null, now, true, true)).toBe(false);
  });

  it('does not lock within the threshold', () => {
    expect(
      shouldLockAfterBackground(now - (BACKGROUND_LOCK_THRESHOLD_MS - 1000), now, true, true),
    ).toBe(false);
  });

  it('locks past the threshold', () => {
    expect(shouldLockAfterBackground(longAgo, now, true, true)).toBe(true);
  });
});

describe('init on a RESTART boot', () => {
  // Every background -> foreground return reloads the app, so the marker read
  // below runs on every return of every locked device. If it came back empty
  // the cold-start branch would engage and the user would be asked for their
  // PIN each time — the most visible possible regression in this change.
  it('READS THE MARKER ROW at init() time', async () => {
    seedRestartMarker(3_000);
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);

    await usePinStore.getState().init();

    expect(mockGetSetting).toHaveBeenCalledWith(RESTART_MARKER_KEY);
    expect(mockDeleteSetting).toHaveBeenCalledWith(RESTART_MARKER_KEY);
  });

  it('does NOT lock after a 3-second background', async () => {
    seedRestartMarker(3_000);
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);

    await usePinStore.getState().init();

    expect(usePinStore.getState().locked).toBe(false);
  });

  it('LOCKS after a 10-minute background, so the threshold still bites', async () => {
    seedRestartMarker(10 * 60_000);
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);

    await usePinStore.getState().init();

    expect(usePinStore.getState().locked).toBe(true);
  });

  it('does not lock when the restart fired with the app foregrounded (OTA)', async () => {
    // No background stamp means the user never left. Restarting them onto a new
    // bundle is not a reason to ask for a PIN.
    seedRestartMarker(null);
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);

    await usePinStore.getState().init();

    expect(usePinStore.getState().locked).toBe(false);
  });

  it('falls back to the cold-start lock on an unreadable marker', async () => {
    // Fail-closed: an unreadable marker must never be the reason a gate is open.
    mockGetSetting.mockResolvedValue('{ not json');
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);

    await usePinStore.getState().init();

    expect(usePinStore.getState().locked).toBe(true);
  });
});

describe('init', () => {
  it('cold start with the lock on and a PIN set → pinSet + locked', async () => {
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);
    await usePinStore.getState().init();
    const s = usePinStore.getState();
    expect(s.pinSet).toBe(true);
    expect(s.lockEnabled).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.initialized).toBe(true);
    expect(mockClearPin).not.toHaveBeenCalled();
  });

  it('runs the one-shot PIN reset BEFORE reading the flags', async () => {
    // Ordering is the whole point. app/index.tsx awaits init() before
    // resolveLaunchRoute, so a device cleared by the reset must report
    // lockEnabled:false on the very launch that clears it. Reading first would
    // route that user to /pin-lock once more on the way through.
    const order: string[] = [];
    mockRunPinForceResetOnce.mockImplementation(() => {
      order.push('reset');
      return Promise.resolve();
    });
    mockIsPinSet.mockImplementation(() => {
      order.push('isPinSet');
      return Promise.resolve(false);
    });
    mockIsAppLockEnabled.mockImplementation(() => {
      order.push('isAppLockEnabled');
      return Promise.resolve(false);
    });

    await usePinStore.getState().init();

    expect(order[0]).toBe('reset');
    expect(order).toContain('isAppLockEnabled');
  });

  it('a throwing reset still leaves the gate OFF rather than blocking launch', async () => {
    // runPinForceResetOnce is total by contract, but init()'s catch is the
    // backstop: failing open is correct for a lock, failing closed strands the
    // user on a screen no entry can satisfy.
    mockRunPinForceResetOnce.mockRejectedValue(new Error('keychain'));
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);

    await usePinStore.getState().init();

    const s = usePinStore.getState();
    expect(s.locked).toBe(false);
    expect(s.lockEnabled).toBe(false);
    expect(s.initialized).toBe(true);
  });

  it('cold start with the lock off → not locked (the default for everyone)', async () => {
    mockIsPinSet.mockResolvedValue(false);
    mockIsAppLockEnabled.mockResolvedValue(false);
    await usePinStore.getState().init();
    const s = usePinStore.getState();
    expect(s.pinSet).toBe(false);
    expect(s.lockEnabled).toBe(false);
    expect(s.locked).toBe(false);
  });

  it('lock off but a stale PIN record present → record cleared, not locked', async () => {
    // The upgrade path: a user who set a PIN back when it was mandatory.
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(false);
    await usePinStore.getState().init();
    expect(mockClearPin).toHaveBeenCalledTimes(1);
    const s = usePinStore.getState();
    expect(s.pinSet).toBe(false);
    expect(s.locked).toBe(false);
  });

  it('lock on but no PIN record → not locked', async () => {
    mockIsPinSet.mockResolvedValue(false);
    mockIsAppLockEnabled.mockResolvedValue(true);
    await usePinStore.getState().init();
    expect(usePinStore.getState().locked).toBe(false);
  });

  it('is idempotent (second call does not re-read)', async () => {
    mockIsPinSet.mockResolvedValue(true);
    mockIsAppLockEnabled.mockResolvedValue(true);
    await usePinStore.getState().init();
    await usePinStore.getState().init();
    expect(mockIsPinSet).toHaveBeenCalledTimes(1);
    expect(mockIsAppLockEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('setLockEnabled', () => {
  it('turning the lock off clears the PIN record and the flag', async () => {
    usePinStore.setState({ pinSet: true, lockEnabled: true, locked: true });
    await usePinStore.getState().setLockEnabled(false);
    expect(mockClearPin).toHaveBeenCalledTimes(1);
    expect(mockSetAppLockEnabled).toHaveBeenCalledWith(false);
    const s = usePinStore.getState();
    expect(s.lockEnabled).toBe(false);
    expect(s.pinSet).toBe(false);
    expect(s.locked).toBe(false);
  });

  it('turning the lock on persists the flag and leaves the PIN record alone', async () => {
    // The caller (Settings → Security) has already persisted a fresh PIN.
    usePinStore.setState({ pinSet: true });
    await usePinStore.getState().setLockEnabled(true);
    expect(mockClearPin).not.toHaveBeenCalled();
    expect(mockSetAppLockEnabled).toHaveBeenCalledWith(true);
    const s = usePinStore.getState();
    expect(s.lockEnabled).toBe(true);
    expect(s.pinSet).toBe(true);
    expect(s.locked).toBe(false);
  });

  it('a failed write leaves the store untouched so the UI cannot claim an unsaved preference', async () => {
    mockSetAppLockEnabled.mockRejectedValue(new Error('keychain unavailable'));
    await expect(usePinStore.getState().setLockEnabled(true)).rejects.toThrow(
      'keychain unavailable',
    );
    expect(usePinStore.getState().lockEnabled).toBe(false);
  });
});

describe('foreground lock timing', () => {
  it('markBackgrounded + handleForeground past threshold locks', () => {
    usePinStore.setState({ pinSet: true, lockEnabled: true });
    const base = 5_000_000;
    usePinStore.getState().markBackgrounded(base);
    usePinStore.getState().handleForeground(base + BACKGROUND_LOCK_THRESHOLD_MS + 1);
    expect(usePinStore.getState().locked).toBe(true);
    // marker cleared after handling
    expect(usePinStore.getState().lastBackgroundedAt).toBeNull();
  });

  it('does not lock on foreground when the lock is off', () => {
    usePinStore.setState({ pinSet: true, lockEnabled: false });
    const base = 5_000_000;
    usePinStore.getState().markBackgrounded(base);
    usePinStore.getState().handleForeground(base + BACKGROUND_LOCK_THRESHOLD_MS + 1);
    expect(usePinStore.getState().locked).toBe(false);
  });

  it('brief background does not lock', () => {
    usePinStore.setState({ pinSet: true, lockEnabled: true });
    const base = 5_000_000;
    usePinStore.getState().markBackgrounded(base);
    usePinStore.getState().handleForeground(base + 1000);
    expect(usePinStore.getState().locked).toBe(false);
  });

  it('setPinSet(true) unlocks (just-entered-PIN case)', () => {
    usePinStore.setState({ locked: true });
    usePinStore.getState().setPinSet(true);
    expect(usePinStore.getState().locked).toBe(false);
    expect(usePinStore.getState().pinSet).toBe(true);
  });

  it('unlock clears locked + background marker', () => {
    usePinStore.setState({ locked: true, lastBackgroundedAt: 123 });
    usePinStore.getState().unlock();
    expect(usePinStore.getState().locked).toBe(false);
    expect(usePinStore.getState().lastBackgroundedAt).toBeNull();
  });
});
