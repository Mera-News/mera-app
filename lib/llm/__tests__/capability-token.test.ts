// Tests for lib/llm/capability-token.ts — AsyncStorage wrapper with
// error-handling. AsyncStorage is mocked globally in jest.setup.js.

const mockSetItem = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockGetItem = jest.fn((..._args: unknown[]): Promise<string | null> => Promise.resolve(null));
const mockRemoveItem = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: (...args: unknown[]) => mockSetItem(...args),
    getItem: (...args: unknown[]) => mockGetItem(...args),
    removeItem: (...args: unknown[]) => mockRemoveItem(...args),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
  },
}));

import { setCapabilityToken, getCapabilityToken, clearCapabilityToken } from '../capability-token';
import logger from '@/lib/logger';

const KEY = 'mera.cycle.capabilityToken';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setCapabilityToken', () => {
  it('stores the token under the expected key', async () => {
    await setCapabilityToken('my-token');
    expect(mockSetItem).toHaveBeenCalledWith(KEY, 'my-token');
    expect(mockSetItem).toHaveBeenCalledTimes(1);
  });

  it('stores an empty string', async () => {
    await setCapabilityToken('');
    expect(mockSetItem).toHaveBeenCalledWith(KEY, '');
  });

  it('does not throw if AsyncStorage throws; logs a warning', async () => {
    mockSetItem.mockRejectedValueOnce(new Error('storage full'));
    await expect(setCapabilityToken('tok')).resolves.toBeUndefined();
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('setCapabilityToken failed'),
    );
  });
});

describe('getCapabilityToken', () => {
  it('returns null when no token is stored', async () => {
    mockGetItem.mockResolvedValueOnce(null);
    const result = await getCapabilityToken();
    expect(result).toBeNull();
    expect(mockGetItem).toHaveBeenCalledWith(KEY);
  });

  it('returns the stored token', async () => {
    mockGetItem.mockResolvedValueOnce('stored-token');
    const result = await getCapabilityToken();
    expect(result).toBe('stored-token');
  });

  it('returns null and logs a warning if AsyncStorage throws', async () => {
    mockGetItem.mockRejectedValueOnce(new Error('read error'));
    const result = await getCapabilityToken();
    expect(result).toBeNull();
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('getCapabilityToken failed'),
    );
  });
});

describe('clearCapabilityToken', () => {
  it('removes the token from AsyncStorage', async () => {
    await clearCapabilityToken();
    expect(mockRemoveItem).toHaveBeenCalledWith(KEY);
    expect(mockRemoveItem).toHaveBeenCalledTimes(1);
  });

  it('does not throw if AsyncStorage throws; logs a warning', async () => {
    mockRemoveItem.mockRejectedValueOnce(new Error('delete error'));
    await expect(clearCapabilityToken()).resolves.toBeUndefined();
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('clearCapabilityToken failed'),
    );
  });
});
