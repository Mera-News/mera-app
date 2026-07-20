// Tests for lib/llm/prewarm.ts — cloud-chat critical-path warming.
// All I/O (attestation, JWT, store) is mocked.

import { ProcessingMode } from '@/lib/generated/graphql-types';

// ─── Mocks (must precede the import under test) ───────────────────────────────

const mockFetchModelPublicKey = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve({ publicKey: 'ab', algo: 'ed25519' }),
);
jest.mock('@/lib/e2ee/e2ee-service', () => ({
  fetchModelPublicKey: (...args: unknown[]) => mockFetchModelPublicKey(...args),
}));

const mockGetJwtToken = jest.fn<Promise<string | null>, unknown[]>(() =>
  Promise.resolve('test-jwt'),
);
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
}));

let mockProcessingMode: ProcessingMode = ProcessingMode.Cloud;
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: () => ({ processingMode: mockProcessingMode }),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn() },
}));

import { BIG_MODEL } from '../constants';
import { prewarmCloudChat } from '../prewarm';

/** Let the fire-and-forget Promise.allSettled + its .then callback settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessingMode = ProcessingMode.Cloud;
  mockFetchModelPublicKey.mockResolvedValue({ publicKey: 'ab', algo: 'ed25519' });
  mockGetJwtToken.mockResolvedValue('test-jwt');
});

describe('prewarmCloudChat', () => {
  it('is a no-op under on-device processing (no gateway hop)', async () => {
    mockProcessingMode = ProcessingMode.OnDevice;

    expect(prewarmCloudChat()).toBeUndefined();
    await flush();

    expect(mockFetchModelPublicKey).not.toHaveBeenCalled();
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('warms attestation (BIG_MODEL) + JWT under cloud processing', async () => {
    prewarmCloudChat();
    await flush();

    expect(mockFetchModelPublicKey).toHaveBeenCalledTimes(1);
    expect(mockFetchModelPublicKey).toHaveBeenCalledWith(BIG_MODEL);
    expect(mockGetJwtToken).toHaveBeenCalledTimes(1);
  });

  it('returns immediately (fire-and-forget, void)', () => {
    expect(prewarmCloudChat()).toBeUndefined();
  });

  it('swallows a failing attestation fetch without throwing', async () => {
    mockFetchModelPublicKey.mockRejectedValueOnce(new Error('NEAR down'));

    // Synchronous return must not throw despite the rejection below.
    expect(() => prewarmCloudChat()).not.toThrow();
    // Settling must not produce an unhandled rejection.
    await expect(flush()).resolves.toBeUndefined();
    expect(mockGetJwtToken).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing JWT fetch without throwing', async () => {
    mockGetJwtToken.mockRejectedValueOnce(new Error('auth down'));

    expect(() => prewarmCloudChat()).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(mockFetchModelPublicKey).toHaveBeenCalledTimes(1);
  });
});
