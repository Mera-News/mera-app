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

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

// AppState listener is a side effect of init(); stub addEventListener so it's a
// no-op and doesn't leak between tests.
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

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
  reset();
});

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
