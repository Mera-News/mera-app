// Tests for lib/llm/prewarm.ts — cloud-chat critical-path warming.
// All I/O (attestation, JWT, model completion, store) is mocked.
//
// prewarm.ts holds module-level dedupe state (lastModelWarmAt), so each test
// re-imports the module fresh via jest.resetModules() to start from a clean
// window.

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

const mockCloudComplete = jest.fn<Promise<string>, unknown[]>(() =>
  Promise.resolve(''),
);
jest.mock('../cloudComplete', () => ({
  cloudComplete: (...args: unknown[]) => mockCloudComplete(...args),
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

import { BIG_MODEL, MODEL_FALLBACKS, SMALL_MODEL } from '../constants';

/** Fresh module instance (resets lastModelWarmAt) using the persistent mocks. */
function loadPrewarm(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../prewarm').prewarmCloudChat as () => void;
}

/** Let the fire-and-forget promise chains + their .then callbacks settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockProcessingMode = ProcessingMode.Cloud;
  mockFetchModelPublicKey.mockResolvedValue({ publicKey: 'ab', algo: 'ed25519' });
  mockGetJwtToken.mockResolvedValue('test-jwt');
  mockCloudComplete.mockResolvedValue('');
});

describe('prewarmCloudChat', () => {
  it('is a no-op under on-device processing (no gateway hop)', async () => {
    mockProcessingMode = ProcessingMode.OnDevice;

    const prewarmCloudChat = loadPrewarm();
    expect(prewarmCloudChat()).toBeUndefined();
    await flush();

    expect(mockFetchModelPublicKey).not.toHaveBeenCalled();
    expect(mockGetJwtToken).not.toHaveBeenCalled();
    expect(mockCloudComplete).not.toHaveBeenCalled();
  });

  it('warms attestation for BOTH primaries + JWT under cloud processing', async () => {
    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();

    // Two fetches, not three: the primaries the app actually sends against.
    // Every gateway call now takes a limiter grant, so each extra prewarm
    // fetch pushes the model warmup (the dominant cold cost) another interval
    // out — and the old three-fetch shape warmed two FALLBACKS while never
    // warming SMALL_MODEL, which is what cloudChatStream defaults to.
    expect(mockFetchModelPublicKey).toHaveBeenCalledTimes(2);
    expect(mockFetchModelPublicKey).toHaveBeenCalledWith(BIG_MODEL, 'interactive');
    expect(mockFetchModelPublicKey).toHaveBeenCalledWith(SMALL_MODEL, 'interactive');
    expect(mockGetJwtToken).toHaveBeenCalled();
  });

  it('does NOT warm the hedge fallbacks — they attest lazily on first use', async () => {
    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();

    const warmed = (mockFetchModelPublicKey.mock.calls as [string][]).map(([m]) => m);
    // Only BIG's fallback is assertable this way: MODEL_FALLBACKS[SMALL_MODEL]
    // IS BIG_MODEL in the current map, so "not warmed" could never hold for it
    // and asserting it would be a check that can only fail.
    expect(warmed).not.toContain(MODEL_FALLBACKS[BIG_MODEL]);
    expect(warmed).toEqual([BIG_MODEL, SMALL_MODEL]);
  });

  it('warms the MODEL only for BIG_MODEL — no throwaway completion for the rest', async () => {
    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();

    const warmedModels = (mockCloudComplete.mock.calls as [{ model: string }][]).map(
      ([req]) => req.model,
    );
    expect(warmedModels).toEqual([BIG_MODEL]);
  });

  it('swallows a failing SECONDARY attestation fetch (never blocks the primary warm)', async () => {
    // Keyed on SMALL_MODEL, which prewarm DOES fetch. Keying it on a fallback
    // would make the rejection unreachable now that fallbacks attest lazily —
    // the spec would pass without ever exercising the failure it names.
    mockFetchModelPublicKey.mockImplementation((model: unknown) =>
      model === SMALL_MODEL
        ? Promise.reject(new Error('attestation down'))
        : Promise.resolve({ publicKey: 'ab', algo: 'ed25519' }),
    );

    const prewarmCloudChat = loadPrewarm();
    expect(() => prewarmCloudChat()).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(mockCloudComplete).toHaveBeenCalledTimes(1);
  });

  it('fires a tiny throwaway completion against BIG_MODEL (max_tokens 1)', async () => {
    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();

    expect(mockCloudComplete).toHaveBeenCalledTimes(1);
    const [req] = mockCloudComplete.mock.calls[0] as [
      { model: string; maxTokens: number },
    ];
    expect(req.model).toBe(BIG_MODEL);
    expect(req.maxTokens).toBe(1);
  });

  it('dedupes the model warmup within the cache window (one completion across calls)', async () => {
    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();
    prewarmCloudChat();
    await flush();

    // Attestation/JWT re-fire (they are cheap + cache-backed), but the model
    // completion is deduped to the attestation-cache window.
    expect(mockCloudComplete).toHaveBeenCalledTimes(1);
  });

  it('skips the model warmup when no JWT is obtainable', async () => {
    mockGetJwtToken.mockResolvedValue(null);

    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();

    expect(mockCloudComplete).not.toHaveBeenCalled();
  });

  it('re-attempts the model warmup after a no-JWT run once auth is available', async () => {
    mockGetJwtToken.mockResolvedValueOnce(null); // allSettled JWT (1st call)
    mockGetJwtToken.mockResolvedValueOnce(null); // warmModel JWT → skips, releases claim

    const prewarmCloudChat = loadPrewarm();
    prewarmCloudChat();
    await flush();
    expect(mockCloudComplete).not.toHaveBeenCalled();

    // Auth now available — the released claim lets the next call warm.
    mockGetJwtToken.mockResolvedValue('test-jwt');
    prewarmCloudChat();
    await flush();
    expect(mockCloudComplete).toHaveBeenCalledTimes(1);
  });

  it('returns immediately (fire-and-forget, void)', () => {
    const prewarmCloudChat = loadPrewarm();
    expect(prewarmCloudChat()).toBeUndefined();
  });

  it('swallows a failing attestation fetch without throwing', async () => {
    mockFetchModelPublicKey.mockRejectedValueOnce(new Error('NEAR down'));

    const prewarmCloudChat = loadPrewarm();
    expect(() => prewarmCloudChat()).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(mockGetJwtToken).toHaveBeenCalled();
  });

  it('swallows a failing JWT fetch without throwing', async () => {
    mockGetJwtToken.mockRejectedValue(new Error('auth down'));

    const prewarmCloudChat = loadPrewarm();
    expect(() => prewarmCloudChat()).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(mockFetchModelPublicKey).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing model completion without throwing', async () => {
    mockCloudComplete.mockRejectedValueOnce(new Error('inference down'));

    const prewarmCloudChat = loadPrewarm();
    expect(() => prewarmCloudChat()).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });
});
