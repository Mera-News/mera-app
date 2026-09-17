// pin-force-reset tests.
//
// This is a destructive one-shot: it clears the PIN gate on every device once.
// The tests therefore exercise the REAL pin-service and app-lock-service over
// an in-memory secure store (same shape as their own suites), because what
// matters is that the actual keys end up gone — asserting against mocked
// helpers would pass even if the wrong keys were cleared.
//
// Two properties carry the risk and are pinned below:
//   - it runs at most ONCE, so a PIN set deliberately AFTER the reset survives;
//   - a failure leaves the marker UNSTAMPED, so the next launch retries rather
//     than recording a reset that never happened.

const mockStore = new Map<string, string>();
// `mock`-prefixed so jest's out-of-scope guard allows them inside the factory.
let mockMarkerReadError: Error | null = null;
let mockWriteError: Error | null = null;

const MARKER = 'testslug_pin_force_reset_v1';

jest.mock('../../utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: (k: string) => {
      if (mockMarkerReadError && k === MARKER) return Promise.reject(mockMarkerReadError);
      return Promise.resolve(mockStore.has(k) ? mockStore.get(k)! : null);
    },
    setItemAsync: (k: string, v: string) => {
      if (mockWriteError) return Promise.reject(mockWriteError);
      mockStore.set(k, v);
      return Promise.resolve();
    },
    deleteItemAsync: (k: string) => {
      mockStore.delete(k);
      return Promise.resolve();
    },
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { slug: 'testslug' } },
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: (_algo: string, data: string) => {
    let h = 0;
    for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) >>> 0;
    return Promise.resolve(h.toString(16).padStart(8, '0'));
  },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), addBreadcrumb: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { isAppLockEnabled, setAppLockEnabled } from '../app-lock-service';
import { isPinSet, setPin } from '../pin-service';
import { runPinForceResetOnce } from '../pin-force-reset';

/** A device that had opted in and set a PIN — the state being reset. */
async function enrolDevice() {
  await setPin('1234');
  await setAppLockEnabled(true);
  expect(await isPinSet()).toBe(true);
  expect(await isAppLockEnabled()).toBe(true);
}

beforeEach(() => {
  mockStore.clear();
  mockMarkerReadError = null;
  mockWriteError = null;
});

describe('runPinForceResetOnce', () => {
  it('clears the PIN record and the opt-in flag on an enrolled device', async () => {
    await enrolDevice();

    await runPinForceResetOnce();

    expect(await isPinSet()).toBe(false);
    expect(await isAppLockEnabled()).toBe(false);
    expect(mockStore.has('testslug_pin_record')).toBe(false);
    expect(mockStore.get(MARKER)).toBe('1');
  });

  it('is a no-op on a device that never had a PIN, and still stamps', async () => {
    await runPinForceResetOnce();

    expect(await isPinSet()).toBe(false);
    expect(await isAppLockEnabled()).toBe(false);
    expect(mockStore.get(MARKER)).toBe('1');
  });

  it('does NOT clear a PIN the user set AFTER the reset', async () => {
    // The regression that matters. If the one-shot re-fired, every user who
    // re-enabled the lock in Settings would silently lose it on next launch.
    await enrolDevice();
    await runPinForceResetOnce();

    await enrolDevice(); // user opts back in via Settings → Security

    await runPinForceResetOnce();

    expect(await isPinSet()).toBe(true);
    expect(await isAppLockEnabled()).toBe(true);
  });

  it('leaves the marker unstamped when the write fails, so the next launch retries', async () => {
    await enrolDevice();
    mockWriteError = new Error('keychain unavailable');

    await runPinForceResetOnce();
    expect(mockStore.has(MARKER)).toBe(false);

    // Next launch, storage healthy again: it completes.
    mockWriteError = null;
    await runPinForceResetOnce();
    expect(await isAppLockEnabled()).toBe(false);
    expect(mockStore.get(MARKER)).toBe('1');
  });

  it('defers rather than resetting when the marker is unreadable', async () => {
    // A pre-first-unlock background wake reads the keychain as a rejection.
    // Treating that as "not yet reset" would clear a PIN set after the reset,
    // so the abort is deliberate: one more launch costs nothing, guessing
    // costs the user's PIN.
    await enrolDevice();
    await runPinForceResetOnce();
    await enrolDevice();

    mockMarkerReadError = new Error('keychain locked');
    await runPinForceResetOnce();

    expect(await isPinSet()).toBe(true);
    expect(await isAppLockEnabled()).toBe(true);
  });

  it('never throws, so it cannot block the launch gate', async () => {
    mockMarkerReadError = new Error('locked');
    await expect(runPinForceResetOnce()).resolves.toBeUndefined();

    mockMarkerReadError = null;
    mockWriteError = new Error('locked');
    await expect(runPinForceResetOnce()).resolves.toBeUndefined();
  });
});
