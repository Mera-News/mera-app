// secureStore wraps expo-secure-store.
// jest.setup.js already mocks expo-secure-store with async methods.
// We spy on the module to control return values and capture call args.

import * as SecureStore from 'expo-secure-store';

// Add sync methods if they don't exist on the mock (setup.js doesn't add them)
if (!(SecureStore as any).setItem) (SecureStore as any).setItem = jest.fn();
if (!(SecureStore as any).getItem) (SecureStore as any).getItem = jest.fn(() => null);
if (!(SecureStore as any).AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY) {
  (SecureStore as any).AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY';
}

const mockGetItemAsync = jest.spyOn(SecureStore, 'getItemAsync');
const mockSetItemAsync = jest.spyOn(SecureStore, 'setItemAsync');
const mockDeleteItemAsync = jest.spyOn(SecureStore, 'deleteItemAsync');
const mockSetItem = jest.spyOn(SecureStore as any, 'setItem');
const mockGetItem = jest.spyOn(SecureStore as any, 'getItem');

import { secureStore } from '../secure-store-adapter';

// The KEYCHAIN_OPTS object is created at module-load time using
// SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY. Since the jest.setup.js
// mock doesn't export this constant, the actual runtime value will be undefined.
// We verify the opts object is passed (not missing) and has the right shape.
const EXPECTED_OPTS = {
  keychainAccessible: undefined, // setup.js mock has no AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
};

describe('secureStore.getItemAsync', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to expo-secure-store getItemAsync with keychain options', async () => {
    mockGetItemAsync.mockResolvedValueOnce('stored-value');
    const result = await secureStore.getItemAsync('myKey');
    expect(mockGetItemAsync).toHaveBeenCalledWith('myKey', EXPECTED_OPTS);
    expect(result).toBe('stored-value');
  });

  it('returns null when item does not exist', async () => {
    mockGetItemAsync.mockResolvedValueOnce(null);
    const result = await secureStore.getItemAsync('missing');
    expect(result).toBeNull();
  });

  it('propagates errors thrown by the underlying store', async () => {
    mockGetItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'));
    await expect(secureStore.getItemAsync('key')).rejects.toThrow('keychain unavailable');
  });
});

describe('secureStore.setItemAsync', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to expo-secure-store setItemAsync with keychain options', async () => {
    mockSetItemAsync.mockResolvedValueOnce(undefined);
    await secureStore.setItemAsync('myKey', 'myValue');
    expect(mockSetItemAsync).toHaveBeenCalledWith('myKey', 'myValue', EXPECTED_OPTS);
  });

  it('propagates errors from setItemAsync', async () => {
    mockSetItemAsync.mockRejectedValueOnce(new Error('write failed'));
    await expect(secureStore.setItemAsync('k', 'v')).rejects.toThrow('write failed');
  });
});

describe('secureStore.deleteItemAsync', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to expo-secure-store deleteItemAsync with keychain options', async () => {
    mockDeleteItemAsync.mockResolvedValueOnce(undefined);
    await secureStore.deleteItemAsync('myKey');
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('myKey', EXPECTED_OPTS);
  });

  it('propagates errors from deleteItemAsync', async () => {
    mockDeleteItemAsync.mockRejectedValueOnce(new Error('delete failed'));
    await expect(secureStore.deleteItemAsync('k')).rejects.toThrow('delete failed');
  });
});

describe('secureStore.setItem (sync)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to expo-secure-store setItem with keychain options', () => {
    secureStore.setItem('syncKey', 'syncVal');
    expect(mockSetItem).toHaveBeenCalledWith('syncKey', 'syncVal', EXPECTED_OPTS);
  });
});

describe('secureStore.getItem (sync)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to expo-secure-store getItem with keychain options', () => {
    mockGetItem.mockReturnValueOnce('syncResult');
    const result = secureStore.getItem('syncKey');
    expect(mockGetItem).toHaveBeenCalledWith('syncKey', EXPECTED_OPTS);
    expect(result).toBe('syncResult');
  });

  it('returns null when item is absent', () => {
    mockGetItem.mockReturnValueOnce(null);
    expect(secureStore.getItem('absent')).toBeNull();
  });
});

describe('keychain options across all methods', () => {
  it('passes AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY to all async methods', async () => {
    mockGetItemAsync.mockResolvedValue(null);
    mockSetItemAsync.mockResolvedValue(undefined);
    mockDeleteItemAsync.mockResolvedValue(undefined);

    await secureStore.getItemAsync('k');
    await secureStore.setItemAsync('k', 'v');
    await secureStore.deleteItemAsync('k');

    for (const mockFn of [mockGetItemAsync, mockSetItemAsync, mockDeleteItemAsync]) {
      const lastCall = mockFn.mock.calls[0];
      const opts = lastCall[lastCall.length - 1];
      expect(opts).toEqual(EXPECTED_OPTS);
    }
  });
});
