// submitInferenceJob.test.ts — unit tests for the submit primitive
// (`sendInferenceRequest`) and `bytesToHex` in lib/llm/submitInferenceJob.ts.

// ---- Mocks (all before imports) ----

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    captureMessage: jest.fn(), captureException: jest.fn(),
  },
}));

const mockWithRetry = jest.fn();
jest.mock('@/lib/utils/retry', () => ({
  withRetry: (...args: unknown[]) => mockWithRetry(...args),
}));

const mockRateLimiterAcquire = jest.fn().mockResolvedValue(undefined);
const mockRateLimiterPauseFor = jest.fn();
jest.mock('../gateway-rate-limiter', () => ({
  acquire: (...args: unknown[]) => mockRateLimiterAcquire(...args),
  pauseFor: (...args: unknown[]) => mockRateLimiterPauseFor(...args),
}));

const mockEncryptContent = jest.fn((text: string) => `enc:${text}`);
jest.mock('@/lib/e2ee/e2ee-service', () => ({
  encryptContent: (...args: unknown[]) => mockEncryptContent(...(args as [string])),
}));

const mockGetJwtToken = jest.fn();
const mockInvalidateJwtCache = jest.fn();
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
  invalidateJwtCache: (...args: unknown[]) => mockInvalidateJwtCache(...args),
}));

const mockRecordAuthFailure = jest.fn();
jest.mock('@/lib/auth-failure-breaker', () => ({
  recordAuthFailure: (...args: unknown[]) => mockRecordAuthFailure(...args),
}));

jest.mock('pako', () => ({
  gzip: jest.fn((input: string) => Buffer.from(input)),
}));

jest.mock('expo-file-system', () => ({
  Directory: jest.fn().mockImplementation(() => ({
    exists: false,
    create: jest.fn(),
  })),
  File: jest.fn().mockImplementation(() => ({
    uri: '/mock/file.md',
    create: jest.fn(),
    write: jest.fn(),
  })),
  Paths: { document: '/mock/document' },
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'http://test-endpoint',
  DUMP_QUERIES_ENABLED: false,
}));

import {
  sendInferenceRequest,
  bytesToHex,
} from '../submitInferenceJob';
import type { CloudCallBundle } from '@/lib/mera-protocol/scoring-service';
import type { E2EEContext } from '@/lib/e2ee/e2ee-service';

// ---- Helpers ----

function makeBundle(callCount = 1) {
  return {
    calls: Array.from({ length: callCount }, (_, i) => ({
      id: `call-${i}`,
      system: 'sys prompt',
      prompt: `user prompt ${i}`,
      temperature: 0.3,
    })),
    eligibleCandidates: Array.from({ length: callCount }, (_, i) => ({ id: `c${i}` })),
    promptsById: new Map<string, string>(),
    chunkIdToCandidates: new Map<string, unknown[]>(),
  } as unknown as CloudCallBundle;
}

function makeE2EEContext(): E2EEContext {
  return {
    privateKey: new Uint8Array([1, 2, 3, 4]),
    headers: { 'X-E2EE-Key': 'abc123' },
    modelPubKeyHex: 'ccdd',
    clientPubKeyHex: 'aabb',
    algo: 'ed25519',
  } as unknown as E2EEContext;
}

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    headers: { get: (name: string) => headers[name] ?? null },
  };
}

describe('bytesToHex', () => {
  it('converts Uint8Array to hex string', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('pads single hex digits with leading zero', () => {
    expect(bytesToHex(new Uint8Array([1]))).toBe('01');
  });

  it('handles empty array', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
  });
});

describe('sendInferenceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJwtToken.mockResolvedValue('jwt-token');
    mockRateLimiterAcquire.mockResolvedValue(undefined);
    mockWithRetry.mockImplementation(async (op: () => Promise<unknown>) => op());
  });

  it('uses JWT Bearer token in foreground context', async () => {
    const response = makeResponse(202, { requestId: 'req-1', capabilityToken: 'cap' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toEqual({ status: 'ok', requestId: 'req-1', capabilityToken: 'cap' });
    expect(mockRateLimiterAcquire).toHaveBeenCalledTimes(1);
    const fetchCall = mockExpoFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers.Authorization).toBe('Bearer jwt-token');
  });

  it('falls back to the passed capability token when JWT is null in foreground', async () => {
    mockGetJwtToken.mockResolvedValue(null);
    const response = makeResponse(202, { requestId: 'req-fb' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
      capabilityToken: 'cap-tok-fallback',
    });

    expect(result).toEqual({ status: 'ok', requestId: 'req-fb', capabilityToken: '' });
    const fetchCall = mockExpoFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer cap-tok-fallback');
  });

  it('prefers JWT over a passed capability token in foreground', async () => {
    mockGetJwtToken.mockResolvedValue('jwt-token');
    const response = makeResponse(202, { requestId: 'req-jwt-first' });
    mockExpoFetch.mockResolvedValue(response);

    await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
      capabilityToken: 'cap-should-not-be-used',
    });

    const fetchCall = mockExpoFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer jwt-token');
  });

  it('throws when foreground has no JWT and no capability token', async () => {
    mockGetJwtToken.mockResolvedValue(null);

    await expect(
      sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'foreground',
      }),
    ).rejects.toThrow('foreground has no JWT and no capability token');
  });

  it('uses the passed capability token in background context (keychain untouched)', async () => {
    const response = makeResponse(202, { requestId: 'req-bg' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'background',
      capabilityToken: 'bg-cap-token',
    });

    expect(result).toEqual({ status: 'ok', requestId: 'req-bg', capabilityToken: '' });
    const fetchCall = mockExpoFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer bg-cap-token');
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('throws when background has no capability token', async () => {
    await expect(
      sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'background',
      }),
    ).rejects.toThrow('no capability token (background)');
  });

  it('returns failed on non-202 response', async () => {
    const response = makeResponse(400, { error: 'bad request' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toEqual({ status: 'failed' });
  });

  it('returns failed when response has no requestId', async () => {
    const response = makeResponse(202, { capabilityToken: 'tok' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toEqual({ status: 'failed' });
  });

  it('returns failed when withRetry throws (retry exhausted)', async () => {
    mockWithRetry.mockRejectedValue(new Error('network error'));

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toEqual({ status: 'failed' });
  });

  it('returns the capability token from the server response (caller persists it)', async () => {
    const response = makeResponse(202, { requestId: 'req-x', capabilityToken: 'new-cap' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    // sendInferenceRequest does not persist the token itself — that's the
    // caller's responsibility now; it just returns it in the outcome.
    expect(result).toEqual({ status: 'ok', requestId: 'req-x', capabilityToken: 'new-cap' });
  });

  it('returns throttled and pauses the rate limiter on 429 with a Retry-After header', async () => {
    const response = makeResponse(429, { error: 'too many requests' }, { 'Retry-After': '5' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toEqual({ status: 'throttled' });
    expect(mockRateLimiterPauseFor).toHaveBeenCalledWith(5000);
  });

  it('defaults to a 30s pause on 429 without a usable Retry-After header', async () => {
    const response = makeResponse(429, { error: 'too many requests' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toEqual({ status: 'throttled' });
    expect(mockRateLimiterPauseFor).toHaveBeenCalledWith(30_000);
  });

  it('hoists shared system to sharedSystem when all calls have the same system', async () => {
    const bundle = makeBundle(2); // 2 calls, both have the same 'sys prompt'
    const response = makeResponse(202, { requestId: 'req-shared' });
    mockExpoFetch.mockResolvedValue(response);

    await sendInferenceRequest({
      bundle,
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    // The body sent to fetch should contain sharedSystem
    const fetchArg = mockExpoFetch.mock.calls[0][1];
    const bodyStr = Buffer.from(fetchArg.body as Buffer).toString();
    const parsed = JSON.parse(bodyStr);
    expect(parsed.sharedSystem).toBeDefined();
  });

  it('does NOT hoist sharedSystem when calls have different system prompts', async () => {
    const bundle = {
      calls: [
        { id: 'c0', system: 'sys-a', prompt: 'p0', temperature: 0.3 },
        { id: 'c1', system: 'sys-b', prompt: 'p1', temperature: 0.3 },
      ],
      eligibleCandidates: [{ id: 'x0' }, { id: 'x1' }],
    } as unknown as CloudCallBundle;
    const response = makeResponse(202, { requestId: 'req-noshard' });
    mockExpoFetch.mockResolvedValue(response);

    await sendInferenceRequest({
      bundle,
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    const fetchArg = mockExpoFetch.mock.calls[0][1];
    const bodyStr = Buffer.from(fetchArg.body as Buffer).toString();
    const parsed = JSON.parse(bodyStr);
    expect(parsed.sharedSystem).toBeUndefined();
  });

  it('falls back to the passed capability token when JWT throws in foreground', async () => {
    mockGetJwtToken.mockRejectedValue(new Error('keychain unavailable'));
    const response = makeResponse(202, { requestId: 'req-throw-fb' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
      capabilityToken: 'fallback-cap',
    });

    expect(result).toEqual({ status: 'ok', requestId: 'req-throw-fb', capabilityToken: '' });
    const fetchCall = mockExpoFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer fallback-cap');
  });

  describe('401/403 recovery (foreground JWT path)', () => {
    it('401 then a successful re-mint retries the POST once and succeeds', async () => {
      const unauthorized = makeResponse(401, { error: 'unauthorized' });
      const success = makeResponse(202, { requestId: 'req-401-retry', capabilityToken: 'cap' });
      mockExpoFetch.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(success);
      mockGetJwtToken.mockResolvedValueOnce('jwt-token').mockResolvedValueOnce('fresh-jwt');

      const result = await sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'foreground',
      });

      expect(result).toEqual({ status: 'ok', requestId: 'req-401-retry', capabilityToken: 'cap' });
      expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
      expect(mockGetJwtToken).toHaveBeenCalledTimes(2);
      expect(mockExpoFetch).toHaveBeenCalledTimes(2);
      expect(mockExpoFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-jwt');
      expect(mockRecordAuthFailure).not.toHaveBeenCalled();
    });

    it('still 401 after the re-mint retry → failed + recordAuthFailure called', async () => {
      const unauthorized = makeResponse(401, { error: 'unauthorized' });
      mockExpoFetch.mockResolvedValue(unauthorized);
      mockGetJwtToken.mockResolvedValueOnce('jwt-token').mockResolvedValueOnce('fresh-jwt-2');

      const result = await sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'foreground',
      });

      expect(result).toEqual({ status: 'failed' });
      expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
      expect(mockExpoFetch).toHaveBeenCalledTimes(2);
      expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('403 behaves the same as 401 — invalidate, re-mint, retry, still-403 records auth failure', async () => {
      const forbidden = makeResponse(403, { error: 'forbidden' });
      mockExpoFetch.mockResolvedValue(forbidden);
      mockGetJwtToken.mockResolvedValueOnce('jwt-token').mockResolvedValueOnce('fresh-jwt-3');

      const result = await sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'foreground',
      });

      expect(result).toEqual({ status: 'failed' });
      expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
      expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('401 with no fresh JWT available → no retry POST attempted, still records auth failure', async () => {
      const unauthorized = makeResponse(401, { error: 'unauthorized' });
      mockExpoFetch.mockResolvedValue(unauthorized);
      mockGetJwtToken.mockResolvedValueOnce('jwt-token').mockResolvedValueOnce(null);

      const result = await sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'foreground',
      });

      expect(result).toEqual({ status: 'failed' });
      expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
      // No fresh JWT → no second fetch attempt.
      expect(mockExpoFetch).toHaveBeenCalledTimes(1);
      expect(mockRecordAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('background 401 does NOT invalidate/re-mint/record an auth failure (stale capability token proves nothing about the session)', async () => {
      const unauthorized = makeResponse(401, { error: 'unauthorized' });
      mockExpoFetch.mockResolvedValue(unauthorized);

      const result = await sendInferenceRequest({
        bundle: makeBundle(),
        ctx: makeE2EEContext(),
        token: null,
        model: 'test-model',
        context: 'background',
        capabilityToken: 'bg-cap-token',
      });

      expect(result).toEqual({ status: 'failed' });
      expect(mockGetJwtToken).not.toHaveBeenCalled();
      expect(mockInvalidateJwtCache).not.toHaveBeenCalled();
      expect(mockRecordAuthFailure).not.toHaveBeenCalled();
      expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    });
  });
});
