const mockIsPinSet = jest.fn();

jest.mock('../../security/pin-service', () => ({
  isPinSet: (...a: any[]) => mockIsPinSet(...a),
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
    locked: false,
    lastBackgroundedAt: null,
    initialized: false,
  });

beforeEach(() => {
  jest.clearAllMocks();
  reset();
});

describe('shouldLockAfterBackground', () => {
  const now = 1_000_000_000;

  it('does not lock without a PIN', () => {
    expect(shouldLockAfterBackground(now - 10 * 60_000, now, false)).toBe(false);
  });

  it('does not lock without a background timestamp', () => {
    expect(shouldLockAfterBackground(null, now, true)).toBe(false);
  });

  it('does not lock within the threshold', () => {
    expect(shouldLockAfterBackground(now - (BACKGROUND_LOCK_THRESHOLD_MS - 1000), now, true)).toBe(false);
  });

  it('locks past the threshold', () => {
    expect(shouldLockAfterBackground(now - (BACKGROUND_LOCK_THRESHOLD_MS + 1000), now, true)).toBe(true);
  });
});

describe('init', () => {
  it('cold start with a PIN set → pinSet + locked', async () => {
    mockIsPinSet.mockResolvedValue(true);
    await usePinStore.getState().init();
    const s = usePinStore.getState();
    expect(s.pinSet).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.initialized).toBe(true);
  });

  it('cold start with no PIN → not locked', async () => {
    mockIsPinSet.mockResolvedValue(false);
    await usePinStore.getState().init();
    const s = usePinStore.getState();
    expect(s.pinSet).toBe(false);
    expect(s.locked).toBe(false);
  });

  it('is idempotent (second call does not re-read)', async () => {
    mockIsPinSet.mockResolvedValue(true);
    await usePinStore.getState().init();
    await usePinStore.getState().init();
    expect(mockIsPinSet).toHaveBeenCalledTimes(1);
  });
});

describe('foreground lock timing', () => {
  it('markBackgrounded + handleForeground past threshold locks', () => {
    usePinStore.setState({ pinSet: true });
    const base = 5_000_000;
    usePinStore.getState().markBackgrounded(base);
    usePinStore.getState().handleForeground(base + BACKGROUND_LOCK_THRESHOLD_MS + 1);
    expect(usePinStore.getState().locked).toBe(true);
    // marker cleared after handling
    expect(usePinStore.getState().lastBackgroundedAt).toBeNull();
  });

  it('brief background does not lock', () => {
    usePinStore.setState({ pinSet: true });
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
