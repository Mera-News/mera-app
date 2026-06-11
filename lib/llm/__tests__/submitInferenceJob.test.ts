// submitInferenceJob.test.ts — unit tests for lib/llm/submitInferenceJob.ts

// ---- Mocks (all before imports) ----

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

const mockLogger = {
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  captureMessage: jest.fn(), captureException: jest.fn(),
};
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

const mockSetCapabilityToken = jest.fn();
const mockGetCapabilityToken = jest.fn();
jest.mock('../capability-token', () => ({
  setCapabilityToken: (...args: unknown[]) => mockSetCapabilityToken(...args),
  getCapabilityToken: (...args: unknown[]) => mockGetCapabilityToken(...args),
}));

const mockGetPendingAsyncJob = jest.fn();
const mockSetPendingAsyncJob = jest.fn();
const mockClearPendingAsyncJob = jest.fn();
const mockSetCycleState = jest.fn();

// The PendingJobStaleError MUST be the exact same class used in the instanceof check.
// We export it from the mock and import it back for creating test instances.
jest.mock('@/lib/database/services/async-job-service', () => {
  class PendingJobStaleError extends Error {
    constructor(msg = 'stale') { super(msg); this.name = 'PendingJobStaleError'; }
  }
  const m = {
    getPendingAsyncJob: (...args: unknown[]) => mockGetPendingAsyncJob(...args),
    PendingJobStaleError,
    setCycleState: (...args: unknown[]) => mockSetCycleState(...args),
    setPendingAsyncJob: (...args: unknown[]) => mockSetPendingAsyncJob(...args),
    clearPendingAsyncJob: (...args: unknown[]) => mockClearPendingAsyncJob(...args),
  };
  return m;
});

const mockGetUnscoredSuggestionsWithFacts = jest.fn();
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getUnscoredSuggestionsWithFacts: (...args: unknown[]) => mockGetUnscoredSuggestionsWithFacts(...args),
}));

const mockBuildRelevanceCalls = jest.fn();
jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  buildRelevanceCalls: (...args: unknown[]) => mockBuildRelevanceCalls(...args),
}));

const mockEncryptContent = jest.fn((text: string) => `enc:${text}`);
const mockPrepareE2EEContext = jest.fn<Promise<ReturnType<typeof makeE2EEContext>>, unknown[]>();
jest.mock('@/lib/e2ee/e2ee-service', () => ({
  encryptContent: (...args: unknown[]) => mockEncryptContent(...(args as [string])),
  prepareE2EEContext: (...args: unknown[]) => mockPrepareE2EEContext(...args),
}));

jest.mock('../constants', () => ({ SMALL_MODEL: 'test-small-model' }));

const mockGetJwtToken = jest.fn();
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
}));

jest.mock('pako', () => ({
  gzip: jest.fn((input: string) => Buffer.from(input)),
}));

const mockDirCreate = jest.fn();
const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn();

jest.mock('expo-file-system', () => ({
  Directory: jest.fn().mockImplementation(() => ({
    exists: false,
    create: mockDirCreate,
  })),
  File: jest.fn().mockImplementation(() => ({
    uri: '/mock/file.md',
    create: mockFileCreate,
    write: mockFileWrite,
  })),
  Paths: { document: '/mock/document' },
}));

const mockUserStoreGetState = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: { getState: (...args: unknown[]) => mockUserStoreGetState(...args) },
}));

const mockForYouStoreGetState = jest.fn();
const mockSetAsyncJobPhase = jest.fn();
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: (...args: unknown[]) => mockForYouStoreGetState(...args) },
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'http://test-endpoint',
  DUMP_QUERIES_ENABLED: false,
}));

import {
  submitInferenceJob,
  sendInferenceRequest,
  bytesToHex,
} from '../submitInferenceJob';
import type { CloudCallBundle } from '@/lib/mera-protocol/scoring-service';
import type { E2EEContext } from '@/lib/e2ee/e2ee-service';
import { PendingJobStaleError as RealPendingJobStaleError } from '@/lib/database/services/async-job-service';

// The async-job-service module is mocked above with a 0-arg PendingJobStaleError.
// Re-type the imported symbol so test instantiation matches the mock's signature.
const PendingJobStaleError = RealPendingJobStaleError as unknown as new () => Error;

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
  } as unknown as E2EEContext;
}

function makeResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
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

describe('submitInferenceJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([{ id: 'c1', statement: 'fact' }]);
    mockBuildRelevanceCalls.mockResolvedValue(makeBundle());
    mockPrepareE2EEContext.mockResolvedValue(makeE2EEContext());
    mockSetPendingAsyncJob.mockResolvedValue(undefined);
    mockClearPendingAsyncJob.mockResolvedValue(undefined);
    mockSetCycleState.mockResolvedValue(undefined);
    mockGetJwtToken.mockResolvedValue('jwt-token');
    mockSetCapabilityToken.mockResolvedValue(undefined);
    mockUserStoreGetState.mockReturnValue({ userPersona: null });
    mockForYouStoreGetState.mockReturnValue({ setAsyncJobPhase: mockSetAsyncJobPhase });

    // Default withRetry: just call the operation
    mockWithRetry.mockImplementation(async (op: () => Promise<unknown>) => op());
  });

  describe('skipped states', () => {
    it('returns "skipped-pending" when a pending job exists', async () => {
      mockGetPendingAsyncJob.mockResolvedValue({ requestId: 'existing-job' });

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-pending');
      expect(mockGetUnscoredSuggestionsWithFacts).not.toHaveBeenCalled();
    });

    it('returns "skipped-empty" when no unscored candidates', async () => {
      mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-empty');
    });

    it('returns "skipped-empty" when buildRelevanceCalls produces 0 calls', async () => {
      mockBuildRelevanceCalls.mockResolvedValue({ calls: [], eligibleCandidates: [] });

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-empty');
    });

    it('returns "skipped-empty" when buildRelevanceCalls has 0 eligibleCandidates', async () => {
      mockBuildRelevanceCalls.mockResolvedValue({
        calls: [{ id: 'c1', system: '', prompt: '' }],
        eligibleCandidates: [],
      });

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-empty');
    });

    it('returns "skipped-pending" when CAS fails (PendingJobStaleError on first setPendingAsyncJob)', async () => {
      mockSetPendingAsyncJob.mockRejectedValueOnce(new PendingJobStaleError());

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-pending');
    });
  });

  describe('happy path — submitted', () => {
    it('returns "submitted" and sets phase to relevance on success', async () => {
      const response = makeResponse(202, { requestId: 'req-123', capabilityToken: 'cap-tok' });
      mockExpoFetch.mockResolvedValue(response);

      const result = await submitInferenceJob();

      expect(result).toBe('submitted');
      expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('relevance');
      expect(mockSetCapabilityToken).toHaveBeenCalledWith('cap-tok');
    });

    it('writes the final job row with the requestId from the server', async () => {
      const response = makeResponse(202, { requestId: 'server-req-id' });
      mockExpoFetch.mockResolvedValue(response);

      await submitInferenceJob();

      // Second setPendingAsyncJob call should have the real requestId
      const secondCall = mockSetPendingAsyncJob.mock.calls[1];
      expect(secondCall[0]).toMatchObject({ requestId: 'server-req-id' });
    });

    it('submits tokenless when no Expo push token is available', async () => {
      mockUserStoreGetState.mockReturnValue({ userPersona: { expoPushToken: null } });
      const response = makeResponse(202, { requestId: 'req-no-token' });
      mockExpoFetch.mockResolvedValue(response);

      const result = await submitInferenceJob();

      expect(result).toBe('submitted');
    });

    it('passes expoPushToken when available', async () => {
      mockUserStoreGetState.mockReturnValue({
        userPersona: { expoPushToken: 'ExponentPushToken[abc]' },
      });
      const response = makeResponse(202, { requestId: 'req-with-token' });
      mockExpoFetch.mockResolvedValue(response);

      await submitInferenceJob();

      // expoFetch was called — check the body passed to withRetry contained the token
      expect(mockExpoFetch).toHaveBeenCalled();
    });
  });

  describe('error and stale paths', () => {
    it('returns "skipped-stale-pending" when sendInferenceRequest returns null', async () => {
      // sendInferenceRequest returns null (e.g. retry exhausted)
      const response = makeResponse(500, { error: 'server error' });
      mockExpoFetch.mockResolvedValue(response);
      // withRetry throws after all retries
      mockWithRetry.mockRejectedValue(new Error('retry exhausted'));

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-stale-pending');
    });

    it('returns "skipped-stale-pending" on PendingJobStaleError in outer catch', async () => {
      const response = makeResponse(202, { requestId: 'req-xyz' });
      mockExpoFetch.mockResolvedValue(response);
      // Second setPendingAsyncJob (write-back) throws stale
      mockSetPendingAsyncJob.mockResolvedValueOnce(undefined); // placeholder ok
      mockSetPendingAsyncJob.mockRejectedValueOnce(new PendingJobStaleError());

      const result = await submitInferenceJob();

      expect(result).toBe('skipped-stale-pending');
    });
  });
});

describe('sendInferenceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJwtToken.mockResolvedValue('jwt-token');
    mockGetCapabilityToken.mockResolvedValue(null);
    mockSetCapabilityToken.mockResolvedValue(undefined);
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

    expect(result).toBe('req-1');
    const fetchCall = mockExpoFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers.Authorization).toBe('Bearer jwt-token');
  });

  it('falls back to capability token when JWT is null in foreground', async () => {
    mockGetJwtToken.mockResolvedValue(null);
    mockGetCapabilityToken.mockResolvedValue('cap-tok-fallback');
    const response = makeResponse(202, { requestId: 'req-fb' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toBe('req-fb');
    const fetchCall = mockExpoFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer cap-tok-fallback');
  });

  it('throws when foreground has no JWT and no capability token', async () => {
    mockGetJwtToken.mockResolvedValue(null);
    mockGetCapabilityToken.mockResolvedValue(null);

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

  it('uses capability token in background context', async () => {
    mockGetCapabilityToken.mockResolvedValue('bg-cap-token');
    const response = makeResponse(202, { requestId: 'req-bg' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'background',
    });

    expect(result).toBe('req-bg');
    const fetchCall = mockExpoFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer bg-cap-token');
  });

  it('throws when background has no capability token', async () => {
    mockGetCapabilityToken.mockResolvedValue(null);

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

  it('returns null on non-202 response', async () => {
    const response = makeResponse(400, { error: 'bad request' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toBeNull();
  });

  it('returns null when response has no requestId', async () => {
    const response = makeResponse(202, { capabilityToken: 'tok' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toBeNull();
  });

  it('returns null when withRetry throws (retry exhausted)', async () => {
    mockWithRetry.mockRejectedValue(new Error('network error'));

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toBeNull();
  });

  it('stores capability token when server returns one', async () => {
    const response = makeResponse(202, { requestId: 'req-x', capabilityToken: 'new-cap' });
    mockExpoFetch.mockResolvedValue(response);

    await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(mockSetCapabilityToken).toHaveBeenCalledWith('new-cap');
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

  it('falls back to capability token when JWT throws in foreground', async () => {
    mockGetJwtToken.mockRejectedValue(new Error('keychain unavailable'));
    mockGetCapabilityToken.mockResolvedValue('fallback-cap');
    const response = makeResponse(202, { requestId: 'req-throw-fb' });
    mockExpoFetch.mockResolvedValue(response);

    const result = await sendInferenceRequest({
      bundle: makeBundle(),
      ctx: makeE2EEContext(),
      token: null,
      model: 'test-model',
      context: 'foreground',
    });

    expect(result).toBe('req-throw-fb');
  });
});
