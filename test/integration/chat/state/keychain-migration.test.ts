// The one-time keychain accessibility migration on the stateful in-memory keychain. A delete + add
// is the only way to change an item's accessibility, so the value is parked in `_afu_tmp` first and
// a failure midway must never lose the better-auth cookie.
import {
  KEYCHAIN_AFU_MIGRATION_KEY,
  MIGRATED_KEYCHAIN_KEYS,
  runKeychainAccessibilityMigration,
} from '@/lib/utils/keychain-accessibility-migration';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { failSecureStore, secureStoreDump } from '@/test/helpers';
import * as SecureStore from 'expo-secure-store';

const [COOKIE, SESSION] = MIGRATED_KEYCHAIN_KEYS;
const tmp = (key: string) => `${key}_afu_tmp`;

/** The jest setup mocks Platform with a plain object whose OS the test may set (both export shapes). */
function setPlatform(os: 'ios' | 'android'): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('react-native/Libraries/Utilities/Platform') as { OS: string; default: { OS: string } };
  mod.OS = os;
  mod.default.OS = os;
}

beforeEach(() => setPlatform('ios'));
afterEach(() => setPlatform('ios'));

describe('on iOS', () => {
  it('re-saves each stored item, keeps its value, leaves no parked copy and writes the marker', async () => {
    await SecureStore.setItemAsync(COOKIE, 'cookie-value');
    await SecureStore.setItemAsync(SESSION, 'session-value');

    expect(await runKeychainAccessibilityMigration()).toBe('migrated');

    expect(secureStoreDump()).toEqual({ [COOKIE]: 'cookie-value', [SESSION]: 'session-value' });
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).not.toBeNull();
  });

  it('moves an item by delete then add, parking the value first (the order is the crash safety)', async () => {
    await SecureStore.setItemAsync(COOKIE, 'c');
    const ops: string[] = [];
    const realSet = SecureStore.setItemAsync;
    const realDelete = SecureStore.deleteItemAsync;
    const spies = [
      jest.spyOn(SecureStore, 'setItemAsync').mockImplementation((key, ...rest) => {
        ops.push(`set:${key}`);
        return realSet(key, ...rest);
      }),
      jest.spyOn(SecureStore, 'deleteItemAsync').mockImplementation((key, ...rest) => {
        ops.push(`del:${key}`);
        return realDelete(key, ...rest);
      }),
    ];
    try {
      await runKeychainAccessibilityMigration();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(ops.filter((o) => o.endsWith(COOKIE) || o.endsWith(tmp(COOKIE)))).toEqual([
      `set:${tmp(COOKIE)}`,
      `del:${COOKIE}`,
      `set:${COOKIE}`,
      `del:${tmp(COOKIE)}`,
    ]);
  });

  it('with nothing stored there is nothing to move, and it still finishes', async () => {
    expect(await runKeychainAccessibilityMigration()).toBe('migrated');
    expect(secureStoreDump()).toEqual({});
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).not.toBeNull();
  });

  it('does nothing once the marker is set', async () => {
    await setSetting(KEYCHAIN_AFU_MIGRATION_KEY, '1');
    await SecureStore.setItemAsync(COOKIE, 'c');
    failSecureStore(COOKIE, 'delete'); // any touch of the item would show

    expect(await runKeychainAccessibilityMigration()).toBe('already-done');
    expect(secureStoreDump()).toEqual({ [COOKIE]: 'c' });
  });

  it('runs once: a second call after success finds the marker', async () => {
    await SecureStore.setItemAsync(COOKIE, 'c');
    expect(await runKeychainAccessibilityMigration()).toBe('migrated');
    expect(await runKeychainAccessibilityMigration()).toBe('already-done');
  });

  it('concurrent calls share one pass', async () => {
    await SecureStore.setItemAsync(COOKIE, 'c');
    const first = runKeychainAccessibilityMigration();
    const second = runKeychainAccessibilityMigration();
    expect(second).toBe(first);
    expect(await first).toBe('migrated');
  });

  it('restores a value parked by a pass that died between the delete and the re-add', async () => {
    await SecureStore.setItemAsync(tmp(COOKIE), 'parked');

    expect(await runKeychainAccessibilityMigration()).toBe('migrated');

    expect(secureStoreDump()[COOKIE]).toBe('parked');
    expect(secureStoreDump()).not.toHaveProperty(tmp(COOKIE));
  });

  it('never overwrites a live cookie with an older parked copy', async () => {
    await SecureStore.setItemAsync(tmp(COOKIE), 'older');
    await SecureStore.setItemAsync(COOKIE, 'newer');

    await runKeychainAccessibilityMigration();

    expect(secureStoreDump()[COOKIE]).toBe('newer');
    expect(secureStoreDump()).not.toHaveProperty(tmp(COOKIE));
  });

  it('fails without a marker and keeps the value parked when the re-add throws', async () => {
    await SecureStore.setItemAsync(COOKIE, 'c');
    failSecureStore(COOKIE, 'set');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(await runKeychainAccessibilityMigration()).toBe('failed');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).toBeNull();
    // The cookie is gone from its own key but not lost: it sits in the parking key.
    expect(secureStoreDump()).toEqual({ [tmp(COOKIE)]: 'c' });
  });

  it('after a failed pass the next foreground restores the cookie and finishes', async () => {
    await SecureStore.setItemAsync(COOKIE, 'c');
    let locked = true;
    const realSet = SecureStore.setItemAsync;
    const lock = jest.spyOn(SecureStore, 'setItemAsync').mockImplementation(((key: string, ...rest: unknown[]) =>
      locked && key === COOKIE
        ? Promise.reject(new Error('keychain locked'))
        : (realSet as (k: string, ...r: unknown[]) => Promise<void>)(key, ...rest)) as never);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(await runKeychainAccessibilityMigration()).toBe('failed');
      expect(secureStoreDump()).toEqual({ [tmp(COOKIE)]: 'c' });

      locked = false;
      expect(await runKeychainAccessibilityMigration()).toBe('migrated');
    } finally {
      lock.mockRestore();
      warn.mockRestore();
    }

    expect(secureStoreDump()).toEqual({ [COOKIE]: 'c' });
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).not.toBeNull();
  });

  it('a read failure leaves the marker unset and the item untouched', async () => {
    await SecureStore.setItemAsync(COOKIE, 'c');
    failSecureStore(COOKIE, 'get');

    expect(await runKeychainAccessibilityMigration()).toBe('failed');
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).toBeNull();
    expect(secureStoreDump()).toEqual({ [COOKIE]: 'c' });
  });
});

describe('on Android', () => {
  it('is not needed: nothing moves and no marker is written', async () => {
    setPlatform('android');
    await SecureStore.setItemAsync(COOKIE, 'c');

    expect(await runKeychainAccessibilityMigration()).toBe('not-needed');

    expect(secureStoreDump()).toEqual({ [COOKIE]: 'c' });
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).toBeNull();
  });
});
