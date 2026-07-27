// app-lock-service tests. The secure-store adapter is mocked with an in-memory
// map (same shape as pin-service.test.ts) so the default-when-absent semantics
// — the thing that makes the PIN opt-in for pre-existing users — are exercised
// against real reads and writes rather than a stubbed return value.

const mockStore = new Map<string, string>();
// `mock`-prefixed so jest's out-of-scope guard allows them inside the factory.
let mockReadError: Error | null = null;
let mockWriteError: Error | null = null;

jest.mock('../../utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: (k: string) =>
      mockReadError
        ? Promise.reject(mockReadError)
        : Promise.resolve(mockStore.has(k) ? mockStore.get(k)! : null),
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

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { isAppLockEnabled, setAppLockEnabled } from '../app-lock-service';

beforeEach(() => {
  mockStore.clear();
  mockReadError = null;
  mockWriteError = null;
});

describe('isAppLockEnabled', () => {
  it('is false when the key has never been written', async () => {
    // The whole point: users who set a PIN under the old mandatory flow have a
    // record but no flag, and must read as opted out.
    expect(await isAppLockEnabled()).toBe(false);
  });

  it('round-trips both values', async () => {
    await setAppLockEnabled(true);
    expect(await isAppLockEnabled()).toBe(true);
    await setAppLockEnabled(false);
    expect(await isAppLockEnabled()).toBe(false);
  });

  it('writes under an app-slug-scoped key', async () => {
    await setAppLockEnabled(true);
    expect([...mockStore.keys()]).toEqual(['testslug_app_lock_enabled']);
  });

  it('treats any unrecognised stored value as off', async () => {
    mockStore.set('testslug_app_lock_enabled', 'true');
    expect(await isAppLockEnabled()).toBe(false);
  });

  it('fails open (false) on a read error rather than stranding the user', async () => {
    mockReadError = new Error('keychain unavailable');
    expect(await isAppLockEnabled()).toBe(false);
  });
});

describe('setAppLockEnabled', () => {
  it('propagates a write failure so the caller can keep the UI honest', async () => {
    mockWriteError = new Error('keychain unavailable');
    await expect(setAppLockEnabled(true)).rejects.toThrow('keychain unavailable');
  });
});
