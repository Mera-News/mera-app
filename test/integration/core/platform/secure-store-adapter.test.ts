// secureStore wraps expo-secure-store and pins every item to AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY.
// The integration setup provides a stateful expo-secure-store, so behaviour is asserted on the
// keychain contents (secureStoreDump) and on injected failures (failSecureStore). The mock keeps
// no accessibility semantics, so this file wraps its functions in pass-through spies for exactly
// one thing: the options argument the adapter passes.
jest.mock('expo-secure-store', () => {
  const real = require('@/test/helpers/storage').secureStoreModule;
  return {
    ...real,
    getItemAsync: jest.fn(real.getItemAsync),
    setItemAsync: jest.fn(real.setItemAsync),
    deleteItemAsync: jest.fn(real.deleteItemAsync),
    getItem: jest.fn(real.getItem),
    setItem: jest.fn(real.setItem),
  };
});

import * as SecureStore from 'expo-secure-store';

import {
  __resetAuthReadQuarantineForTests,
  releaseAuthReadQuarantine,
} from '@/lib/security/install-boundary-latch';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { failSecureStore, secureStoreDump } from '@/test/helpers';

const OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const spy = (name: 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync' | 'getItem' | 'setItem') =>
  (SecureStore as unknown as Record<string, jest.Mock>)[name];

// The adapter's sync reads are latched until the install boundary decides; only the last
// describe is about the latch itself.
beforeEach(() => releaseAuthReadQuarantine());

describe('keychain options', () => {
  it('the pinned accessibility is a real constant, not undefined', () => {
    expect(OPTS.keychainAccessible).toBeDefined();
  });

  it('passes AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY to every method', async () => {
    await secureStore.getItemAsync('k');
    await secureStore.setItemAsync('k', 'v');
    await secureStore.deleteItemAsync('k');
    secureStore.setItem('k', 'v');
    secureStore.getItem('k');

    expect(spy('getItemAsync')).toHaveBeenCalledWith('k', OPTS);
    expect(spy('setItemAsync')).toHaveBeenCalledWith('k', 'v', OPTS);
    expect(spy('deleteItemAsync')).toHaveBeenCalledWith('k', OPTS);
    expect(spy('setItem')).toHaveBeenCalledWith('k', 'v', OPTS);
    expect(spy('getItem')).toHaveBeenCalledWith('k', OPTS);
  });
});

describe('secureStore.getItemAsync', () => {
  it('reads what the keychain holds', async () => {
    await secureStore.setItemAsync('myKey', 'stored-value');
    expect(await secureStore.getItemAsync('myKey')).toBe('stored-value');
  });

  it('returns null when item does not exist', async () => {
    expect(await secureStore.getItemAsync('missing')).toBeNull();
  });

  it('propagates errors thrown by the underlying store', async () => {
    failSecureStore('key', 'get', new Error('keychain unavailable'));
    await expect(secureStore.getItemAsync('key')).rejects.toThrow('keychain unavailable');
  });
});

describe('secureStore.setItemAsync', () => {
  it('writes the value into the keychain', async () => {
    await secureStore.setItemAsync('myKey', 'myValue');
    expect(secureStoreDump()).toEqual({ myKey: 'myValue' });
  });

  it('propagates errors from setItemAsync and writes nothing', async () => {
    failSecureStore('k', 'set', new Error('write failed'));
    await expect(secureStore.setItemAsync('k', 'v')).rejects.toThrow('write failed');
    expect(secureStoreDump()).toEqual({});
  });
});

describe('secureStore.deleteItemAsync', () => {
  it('removes only that key from the keychain', async () => {
    await secureStore.setItemAsync('myKey', 'v');
    await secureStore.setItemAsync('other', 'o');
    await secureStore.deleteItemAsync('myKey');
    expect(secureStoreDump()).toEqual({ other: 'o' });
  });

  it('propagates errors from deleteItemAsync and keeps the item', async () => {
    await secureStore.setItemAsync('k', 'v');
    failSecureStore('k', 'delete', new Error('delete failed'));
    await expect(secureStore.deleteItemAsync('k')).rejects.toThrow('delete failed');
    expect(secureStoreDump()).toEqual({ k: 'v' });
  });
});

describe('secureStore.setItem (sync)', () => {
  it('writes the value into the keychain', () => {
    secureStore.setItem('syncKey', 'syncVal');
    expect(secureStoreDump()).toEqual({ syncKey: 'syncVal' });
  });

  // Sentry MERA-APP-5J: better-auth's expoClient calls this synchronously
  // with no try/catch of its own. A locked keychain (pre-first-unlock
  // background wake) must degrade silently rather than throw into
  // better-auth.
  it('does not throw when the underlying sync setItem throws, and writes nothing', () => {
    failSecureStore('syncKey', 'set', new Error('keychain locked'));
    expect(() => secureStore.setItem('syncKey', 'syncVal')).not.toThrow();
    expect(secureStoreDump()).toEqual({});
  });
});

describe('secureStore.getItem (sync)', () => {
  it('reads what the keychain holds', async () => {
    await secureStore.setItemAsync('syncKey', 'syncResult');
    expect(secureStore.getItem('syncKey')).toBe('syncResult');
  });

  it('returns null when item is absent', () => {
    expect(secureStore.getItem('absent')).toBeNull();
  });

  // Sentry MERA-APP-5J: same rationale as setItem above: a synchronous
  // keychain-locked throw must degrade to "nothing cached" (null), not an
  // uncaught exception straight into better-auth.
  it('returns null (does not throw) when the underlying sync getItem throws', async () => {
    await secureStore.setItemAsync('syncKey', 'there');
    failSecureStore('syncKey', 'get', new Error('keychain locked'));
    expect(secureStore.getItem('syncKey')).toBeNull();
  });
});

// S12 install-boundary quarantine (sync reads only)
describe('secureStore.getItem under the install-boundary quarantine', () => {
  const AUTH_KEYS = [
    'meraapp_cookie',
    'meraapp_session_data',
    'meraapp_appattest_key_id',
    'meraapp_device_attest_device_id',
  ];

  beforeEach(async () => {
    for (const key of [...AUTH_KEYS, 'myKey', 'meraapp_device_ref']) {
      await secureStore.setItemAsync(key, 'real-value');
    }
    spy('getItem').mockClear();
    __resetAuthReadQuarantineForTests();
  });
  afterAll(() => releaseAuthReadQuarantine());

  it('answers null for the auth/device keys while latched, without touching the keychain', () => {
    for (const key of AUTH_KEYS) {
      expect(secureStore.getItem(key)).toBeNull();
    }
    expect(spy('getItem')).not.toHaveBeenCalled();
  });

  it('never gates non-auth keys, and never gates the deviceRef (async-only key)', () => {
    expect(secureStore.getItem('myKey')).toBe('real-value');
    expect(secureStore.getItem('meraapp_device_ref')).toBe('real-value');
  });

  it('reads normally once the boundary releases the latch', () => {
    releaseAuthReadQuarantine();
    expect(secureStore.getItem('meraapp_cookie')).toBe('real-value');
  });

  it('async reads are deliberately NOT gated (the boundary itself uses them)', async () => {
    await expect(secureStore.getItemAsync('meraapp_cookie')).resolves.toBe('real-value');
  });
});
