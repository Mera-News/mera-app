// async-job-reconciler.test.ts — comprehensive tests for async-job-reconciler
// Priority: decode/dispatch/phase-handling branch coverage
//
// The reconciler has a module-level single-flight guard (`inFlight`). Each test
// that exercises the inner logic needs a fresh module instance. We achieve this
// via jest.isolateModules inside each it() that directly calls the reconciler,
// keeping all top-level mock fns shared (they bridge across isolateModules via
// the closure — the module factory re-reads them on every require).

const mockGetPendingAsyncJob = jest.fn();
const mockClearPendingAsyncJob = jest.fn();
const mockSetPendingAsyncJob = jest.fn();
const mockSetCycleState = jest.fn();
const mockGetNotifDispatchedFor = jest.fn();
const mockSetNotifDispatchedFor = jest.fn();
const mockGetJwtToken = jest.fn();
const mockGetCapabilityToken = jest.fn();
const mockClearCapabilityToken = jest.fn();
const mockDecryptContent = jest.fn();
const mockPrepareE2EEContext = jest.fn();
const mockSaveScoringResult = jest.fn();
const mockSaveReason = jest.fn();
const mockDeleteSuggestionsByServerIds = jest.fn();
const mockGetScoredSuggestionsWithoutReasons = jest.fn();
const mockGetUnscoredSuggestionsWithFacts = jest.fn();
const mockBatchMarkReasonSkipped = jest.fn();
const mockBucketScores = jest.fn();
const mockDecodeResults = jest.fn();
const mockBuildReasonCallsForSubset = jest.fn();
const mockSendInferenceRequest = jest.fn();
const mockBytesToHex = jest.fn();
const mockDispatchResultsNotification = jest.fn();
const mockRefreshSuggestionsInStoreUnsafe = jest.fn();
const mockSetAsyncJobPhase = jest.fn();
const mockMarkProcessingRunFinished = jest.fn();
const mockExpoFetch = jest.fn();
const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();
const mockWarn = jest.fn();
const mockInfo = jest.fn();

// PendingJobStaleError — defined inside the jest.mock factory so the source's
// `instanceof PendingJobStaleError` check works. Test code that needs to throw
// this error reads it from the mock module via the `getStaleError` helper below
// (defined after the import so the mock registry is ready).
// The outer class alias is kept only for TypeScript type annotations.
class MockPendingJobStaleError extends Error {
  constructor(expected?: string | null, actual?: string | null) {
    super(`CAS mismatch: expected=${expected} actual=${actual}`);
    this.name = 'PendingJobStaleError';
  }
}

jest.mock('expo/fetch', () => ({
  fetch: (...args: any[]) => mockExpoFetch(...args),
}));

jest.mock('expo-file-system', () => ({
  Directory: jest.fn().mockImplementation(() => ({
    exists: false,
    create: jest.fn(),
  })),
  File: jest.fn().mockImplementation(() => ({
    uri: '/tmp/test.md',
    create: jest.fn(),
    write: jest.fn(),
  })),
  Paths: { document: '/tmp/docs' },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: (...args: any[]) => mockWarn(...args),
    info: (...args: any[]) => mockInfo(...args),
    captureException: (...args: any[]) => mockCaptureException(...args),
    captureMessage: jest.fn(),
  },
}));

jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: any[]) => mockGetJwtToken(...args),
}));

jest.mock('@/lib/llm/capability-token', () => ({
  clearCapabilityToken: (...args: any[]) => mockClearCapabilityToken(...args),
  getCapabilityToken: (...args: any[]) => mockGetCapabilityToken(...args),
}));

jest.mock('@/lib/e2ee/e2ee-service', () => ({
  decryptContent: (...args: any[]) => mockDecryptContent(...args),
  prepareE2EEContext: (...args: any[]) => mockPrepareE2EEContext(...args),
}));

jest.mock('@/lib/database/services/async-job-service', () => {
  // Define PendingJobStaleError inline so `instanceof` in the source works.
  // (Outer class/const declarations are undefined when jest.mock factories run
  // because Babel hoists imports above variable initialisation.)
  class PendingJobStaleError extends Error {
    constructor(expected?: string | null, actual?: string | null) {
      super(`CAS mismatch: expected=${expected} actual=${actual}`);
      this.name = 'PendingJobStaleError';
    }
  }
  return {
    clearPendingAsyncJob: (...args: any[]) => mockClearPendingAsyncJob(...args),
    getNotifDispatchedFor: (...args: any[]) => mockGetNotifDispatchedFor(...args),
    getPendingAsyncJob: (...args: any[]) => mockGetPendingAsyncJob(...args),
    PendingJobStaleError,
    setCycleState: (...args: any[]) => mockSetCycleState(...args),
    setNotifDispatchedFor: (...args: any[]) => mockSetNotifDispatchedFor(...args),
    setPendingAsyncJob: (...args: any[]) => mockSetPendingAsyncJob(...args),
  };
});

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: jest.fn(() => ({
      setAsyncJobPhase: mockSetAsyncJobPhase,
      markProcessingRunFinished: mockMarkProcessingRunFinished,
      articleCount: 10,
      setCounts: jest.fn(),
    })),
    // setState needed by the real refreshSuggestionsInStore when dynamic import falls through mock
    setState: jest.fn(),
  },
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: {
    getState: jest.fn(() => ({
      userPersona: { expoPushToken: 'ExponentPushToken[test]' },
    })),
  },
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  batchMarkReasonSkipped: (...args: any[]) => mockBatchMarkReasonSkipped(...args),
  deleteSuggestionsByServerIds: (...args: any[]) => mockDeleteSuggestionsByServerIds(...args),
  getScoredSuggestionsWithoutReasons: (...args: any[]) => mockGetScoredSuggestionsWithoutReasons(...args),
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscoredSuggestionsWithFacts(...args),
  saveReason: (...args: any[]) => mockSaveReason(...args),
  saveScoringResult: (...args: any[]) => mockSaveScoringResult(...args),
  // loadSuggestions needed when SuggestionSyncService runs via dynamic import
  loadSuggestions: () => Promise.resolve([]),
}));

jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  bucketScores: (...args: any[]) => mockBucketScores(...args),
  buildReasonCallsForSubset: (...args: any[]) => mockBuildReasonCallsForSubset(...args),
  decodeResults: (...args: any[]) => mockDecodeResults(...args),
  CLOUD_SCORE_CHUNK_SIZE: 5,
  REASON_MIN_RAW_SCORE: 0.3,
}));

jest.mock('@/lib/services/notification-dispatch', () => ({
  dispatchResultsNotification: (...args: any[]) => mockDispatchResultsNotification(...args),
}));

// Mock SuggestionSyncService. When Babel (metro caller) doesn't transform dynamic import()
// to require(), the mock may not intercept it. We also mock all SuggestionSyncService's own
// deps so the real refreshSuggestionsInStoreUnsafe (which only touches loadSuggestions +
// useForYouStore, both mocked) can run safely if the dynamic import falls through.
jest.mock('@/lib/services/SuggestionSyncService', () => ({
  refreshSuggestionsInStoreUnsafe: (...args: any[]) => mockRefreshSuggestionsInStoreUnsafe(...args),
}));

// Additional deps that SuggestionSyncService uses (needed when dynamic import falls through mock)
jest.mock('@/lib/mera-protocol-toolkit', () => ({
  initBaseModel: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/background/run-inference-handler', () => ({
  runBackgroundCycle: jest.fn().mockResolvedValue('no-work'),
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: jest.fn(() => ({ processingMode: 'CLOUD', modelState: 'ready', setModelState: jest.fn() })),
  },
}));
jest.mock('@/lib/generated/graphql-types', () => ({
  ProcessingMode: { OnDevice: 'ON_DEVICE', Cloud: 'CLOUD' },
}));
jest.mock('@/lib/stores/on-device-banner-store', () => ({
  useOnDeviceBannerStore: {
    getState: jest.fn(() => ({ show: jest.fn(), hide: jest.fn() })),
  },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock('@/lib/llm/submitInferenceJob', () => ({
  bytesToHex: (...args: any[]) => mockBytesToHex(...args),
  sendInferenceRequest: (...args: any[]) => mockSendInferenceRequest(...args),
}));

jest.mock('@/lib/llm/constants', () => ({
  SMALL_MODEL: 'test-small-model',
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.test',
  DUMP_QUERIES_ENABLED: false,
}));

jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  startInactiveSpan: jest.fn(() => null),
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

import {
  reconcileAsyncJobResults,
  submitOrphanedReasonJob,
} from '@/lib/services/async-job-reconciler';

// Access the PendingJobStaleError class from the mock registry — it is the
// same class the source file's `instanceof` checks reference, so throwing it
// in mocks properly exercises the catch branches.
const { PendingJobStaleError: StaleError } = jest.requireMock('@/lib/database/services/async-job-service') as { PendingJobStaleError: new (...args: any[]) => Error };

const NOW = 1_700_000_000_000;

function makePendingJob(overrides: Record<string, any> = {}) {
  return {
    requestId: 'req-123',
    phase: 'reasons' as const,
    candidateIds: ['c1', 'c2'],
    callIds: ['score:0'],
    relevanceMap: { c1: 0.8, c2: 0.4 },
    submittedAt: NOW - 1000,
    expoPushToken: 'ExponentPushToken[test]',
    modelCalls: 1,
    clientPrivKeyHex: 'aabbccdd',
    idempotencyKey: 'idem-key-1',
    ...overrides,
  };
}

function makeServerResults(results: any[] = []) {
  return {
    requestId: 'req-123',
    results,
  };
}

function makeFetchResponse(body: any, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

// Reset all mock fns + timers before each test; the module itself is
// NOT reset (static import used), but the in-flight guard clears when
// its promise resolves.
beforeEach(() => {
  // Use resetAllMocks to also flush any unconsumed mockRejectedValueOnce /
  // mockResolvedValueOnce queues.  clearAllMocks() only clears usage records
  // (calls/instances/results) and leaves "once" queues intact — if an earlier
  // test sets a mockRejectedValueOnce that never fires (e.g. because a dynamic
  // import throws before the call site is reached), the unconsumed entry leaks
  // into the next test and causes spurious failures.
  // After resetAllMocks the mock factory's permanent implementations (like
  // useForYouStore.getState) are also reset, so we restore the defaults below.
  jest.resetAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  // Re-wire getState for store mocks that use permanent implementations.
  const { useForYouStore } = jest.requireMock('@/lib/stores/for-you-store') as any;
  useForYouStore.getState.mockReturnValue({
    setAsyncJobPhase: mockSetAsyncJobPhase,
    markProcessingRunFinished: mockMarkProcessingRunFinished,
    articleCount: 10,
    setCounts: jest.fn(),
  });
  const { useUserStore } = jest.requireMock('@/lib/stores/user-store') as any;
  useUserStore.getState.mockReturnValue({
    userPersona: { expoPushToken: 'ExponentPushToken[test]' },
  });

  // Default happy-path mocks
  mockGetJwtToken.mockResolvedValue('jwt-token');
  mockGetCapabilityToken.mockResolvedValue('cap-token');
  mockClearCapabilityToken.mockResolvedValue(undefined);
  mockClearPendingAsyncJob.mockResolvedValue(undefined);
  mockSetCycleState.mockResolvedValue(undefined);
  mockSetPendingAsyncJob.mockResolvedValue(undefined);
  mockSetNotifDispatchedFor.mockResolvedValue(undefined);
  mockGetNotifDispatchedFor.mockResolvedValue(null);
  mockSaveScoringResult.mockResolvedValue(undefined);
  mockSaveReason.mockResolvedValue(undefined);
  mockDeleteSuggestionsByServerIds.mockResolvedValue(0);
  mockRefreshSuggestionsInStoreUnsafe.mockResolvedValue(undefined);
  mockDispatchResultsNotification.mockResolvedValue(undefined);
  mockDecryptContent.mockReturnValue('decrypted-output');
  mockBytesToHex.mockReturnValue('aabbccdd');
  mockPrepareE2EEContext.mockResolvedValue({
    privateKey: new Uint8Array(32),
    publicKey: new Uint8Array(32),
  });
  mockBatchMarkReasonSkipped.mockResolvedValue(undefined);
  mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([]);
  mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
  mockBuildReasonCallsForSubset.mockResolvedValue({
    calls: [{ id: 'reason:c1', messages: [] }],
    eligibleCandidates: [{ id: 'c1', titleEn: 'title', relatedFacts: [{}] }],
  });
  mockSendInferenceRequest.mockResolvedValue('new-req-456');
  mockDecodeResults.mockReturnValue({
    scoreMap: new Map(),
    reasonMap: new Map(),
    failedIds: new Set(),
  });
  mockBucketScores.mockReturnValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('reconcileAsyncJobResults — no pending job', () => {
  it('returns completed immediately when no pending job exists', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('completed');
    expect(mockExpoFetch).not.toHaveBeenCalled();
  });
});

describe('reconcileAsyncJobResults — stale job', () => {
  it('returns stale and clears when job age exceeds 1 hour', async () => {
    const staleJob = makePendingJob({ submittedAt: NOW - 2 * 60 * 60 * 1000 });
    mockGetPendingAsyncJob.mockResolvedValue(staleJob);

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockClearPendingAsyncJob).toHaveBeenCalled();
    expect(mockClearCapabilityToken).toHaveBeenCalled();
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('idle');
  });
});

describe('reconcileAsyncJobResults — placeholder requestId', () => {
  it('returns pending when placeholder is fresh (< 60s old)', async () => {
    const freshPlaceholder = makePendingJob({
      requestId: 'placeholder-fresh-1234',
      submittedAt: NOW - 10_000,
    });
    mockGetPendingAsyncJob.mockResolvedValue(freshPlaceholder);

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('pending');
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('placeholder still fresh'),
    );
  });

  it('clears stuck placeholder (> 60s old) and returns stale', async () => {
    const stuckPlaceholder = makePendingJob({
      requestId: 'placeholder-stuck-abcd',
      submittedAt: NOW - 90_000,
    });
    mockGetPendingAsyncJob.mockResolvedValue(stuckPlaceholder);

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockClearPendingAsyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRequestId: stuckPlaceholder.requestId }),
    );
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
  });

  it('ignores PendingJobStaleError when clearing stuck placeholder', async () => {
    const stuckPlaceholder = makePendingJob({
      requestId: 'placeholder-stuck-xyz',
      submittedAt: NOW - 90_000,
    });
    mockGetPendingAsyncJob.mockResolvedValue(stuckPlaceholder);
    mockClearPendingAsyncJob.mockRejectedValueOnce(new StaleError());

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
  });
});

describe('reconcileAsyncJobResults — fetchResults paths', () => {
  it('returns pending when server responds with pending:true', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('pending');
  });

  it('clears job and returns stale on 404', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({
      status: 404,
      ok: false,
      text: jest.fn(),
    });

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockClearPendingAsyncJob).toHaveBeenCalled();
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
  });

  it('clears job and returns stale on 401 (expired/invalid capability token)', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({
      status: 401,
      ok: false,
      text: jest.fn(),
    });

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockClearPendingAsyncJob).toHaveBeenCalled();
    expect(mockClearCapabilityToken).toHaveBeenCalled();
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('idle');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('unauthorized'),
    );
  });

  it('clears job and returns stale on 403 (expired/invalid capability token)', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({
      status: 403,
      ok: false,
      text: jest.fn(),
    });

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockClearPendingAsyncJob).toHaveBeenCalled();
    expect(mockClearCapabilityToken).toHaveBeenCalled();
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('idle');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('unauthorized'),
    );
  });

  it('returns error on non-404 HTTP error', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({
      status: 500,
      ok: false,
      text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'server down' })),
    });

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('returns error when fetch throws entirely', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockRejectedValue(new Error('network error'));

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('reconcileAsyncJobResults — foreground auth header', () => {
  it('uses JWT bearer token in foreground context', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetJwtToken.mockResolvedValue('my-jwt');

    await reconcileAsyncJobResults('foreground');

    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.stringContaining(job.requestId),
      expect.objectContaining({
        headers: { Authorization: 'Bearer my-jwt' },
      }),
    );
  });

  it('falls back to capability token when JWT is null in foreground', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetJwtToken.mockResolvedValue(null);
    mockGetCapabilityToken.mockResolvedValue('cap-fallback');

    await reconcileAsyncJobResults('foreground');

    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer cap-fallback' },
      }),
    );
  });

  it('throws and returns error when no auth available in foreground', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockGetJwtToken.mockResolvedValue(null);
    mockGetCapabilityToken.mockResolvedValue(null);

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('error');
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('no JWT and no capability token'),
      }),
    );
  });

  it('uses capability token only in background context', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetCapabilityToken.mockResolvedValue('bg-cap-token');

    await reconcileAsyncJobResults('background');

    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer bg-cap-token' },
      }),
    );
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('throws and returns error when no capability token in background', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockGetCapabilityToken.mockResolvedValue(null);

    const result = await reconcileAsyncJobResults('background');

    expect(result).toBe('error');
  });

  it('falls back to capability token when JWT throws in foreground', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetJwtToken.mockRejectedValue(new Error('keychain locked'));
    mockGetCapabilityToken.mockResolvedValue('fallback-cap');

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('pending');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('getJwtToken threw'));
  });
});

// babel.config.js now applies @babel/plugin-transform-modules-commonjs in the test env,
// so dynamic `import()` is rewritten to require()-based promise. All tests that were
// previously skipped with "SOURCE ENV LIMITATION / dynamic import" are now un-skipped.

describe('reconcileAsyncJobResults — reason phase (phase-2)', () => {
  function makeReasonJob() {
    return makePendingJob({
      phase: 'reasons',
      candidateIds: ['c1', 'c2'],
      callIds: ['reason:c1', 'reason:c2'],
      relevanceMap: { c1: 0.8, c2: 0.5 },
    });
  }

  function makeServerReasonResponse() {
    return makeServerResults([
      { id: 'reason:c1', ok: true, response: { choices: [{ message: { content: 'enc-c1' } }] } },
      { id: 'reason:c2', ok: true, response: { choices: [{ message: { content: 'enc-c2' } }] } },
    ]);
  }

  beforeEach(() => {
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map([['c1', 'reason text c1'], ['c2', 'reason text c2']]),
      failedIds: new Set(),
    });
  });

  it('saves reasons for all candidateIds in phase-2', async () => {
    const job = makeReasonJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));

    await reconcileAsyncJobResults('foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('c1', 'reason text c1');
    expect(mockSaveReason).toHaveBeenCalledWith('c2', 'reason text c2');
  });

  it('transitions to unpacking-reason state when phase-2 results arrive', async () => {
    const job = makeReasonJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));

    await reconcileAsyncJobResults('foreground');

    expect(mockSetCycleState).toHaveBeenCalledWith('unpacking-reason');
  });

  it('skips candidateId if not in reasonMap', async () => {
    const job = makeReasonJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map([['c1', 'reason for c1']]),
      failedIds: new Set(),
    });

    await reconcileAsyncJobResults('foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('c1', 'reason for c1');
    expect(mockSaveReason).not.toHaveBeenCalledWith('c2', expect.any(String));
  });

  it('skips candidateId if in failedIds', async () => {
    const job = makeReasonJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map([['c1', 'reason']]),
      failedIds: new Set(['c2']),
    });

    await reconcileAsyncJobResults('foreground');

    expect(mockSaveReason).toHaveBeenCalledTimes(1);
    expect(mockSaveReason).not.toHaveBeenCalledWith('c2', expect.any(String));
  });

  it('ignores record-not-found errors when saving reason (swallowed, continues processing)', async () => {
    const job = makeReasonJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));
    mockSaveReason.mockRejectedValueOnce(new Error('Record article_suggestions#c1 not found'));

    // Should not throw — record-not-found is swallowed, processing continues
    await expect(reconcileAsyncJobResults('foreground')).resolves.toBeDefined();
    // c2 is still processed even though c1's save failed
    expect(mockSaveReason).toHaveBeenCalledWith('c2', 'reason text c2');
  });

  it('calls captureException for non-record-not-found errors when saving reason', async () => {
    const job = makeReasonJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));
    mockSaveReason.mockRejectedValueOnce(new Error('Some unexpected DB error'));

    await reconcileAsyncJobResults('foreground');

    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('buckets legacy combined flow scores before processing', async () => {
    // When phase='reasons' with no phase marker, it's the legacy combined path
    const legacyJob = {
      ...makeReasonJob(),
      phase: undefined as any,
      relevanceMap: undefined,
      idempotencyKey: undefined,
    };
    mockGetPendingAsyncJob.mockResolvedValue(legacyJob);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerReasonResponse()));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c1', 0.9], ['c2', 0.2]]),
      reasonMap: new Map([['c1', 'reason-c1']]),
      failedIds: new Set(),
    });

    await reconcileAsyncJobResults('foreground');

    // bucketScores is called for legacy combined flow
    expect(mockBucketScores).toHaveBeenCalled();
  });

  it('legacy flow: saves scoring result for each candidate with score', async () => {
    const legacyJob = {
      ...makeReasonJob(),
      phase: undefined as any,
      relevanceMap: undefined,
      idempotencyKey: undefined,
    };
    mockGetPendingAsyncJob.mockResolvedValue(legacyJob);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'score:0', ok: true, response: { choices: [{ message: { content: 'enc' } }] } },
    ])));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c1', 0.9], ['c2', 0.2]]),
      reasonMap: new Map([['c1', 'reason-c1']]),
      failedIds: new Set(),
    });

    await reconcileAsyncJobResults('foreground');

    // saveScoringResult called BEFORE dynamic import
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c1', expect.objectContaining({ relevance: 0.9 }));
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c2', expect.objectContaining({ relevance: 0.2, reasonSkipped: true }));
  });
});

describe('reconcileAsyncJobResults — legacy combined flow (no phase)', () => {
  function makeLegacyJob() {
    return {
      ...makePendingJob(),
      phase: undefined as any,
      candidateIds: ['c1', 'c2'],
      callIds: ['score:0'],
      relevanceMap: undefined,
      idempotencyKey: undefined,
    };
  }

  beforeEach(() => {
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c1', 0.9], ['c2', 0.2]]),
      reasonMap: new Map([['c1', 'reason-c1']]),
      failedIds: new Set(),
    });
  });

  it('saves both score and reason in legacy combined flow (pre-import work)', async () => {
    const job = makeLegacyJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'score:0', ok: true, response: { choices: [{ message: { content: 'enc-data' } }] } },
    ])));

    await reconcileAsyncJobResults('foreground');

    // saveScoringResult is called before the dynamic import — verifiable
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c1', expect.objectContaining({ relevance: 0.9 }));
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c2', expect.objectContaining({ relevance: 0.2 }));
  });

  it('marks reason as skipped when relevance < 0.4 in legacy flow', async () => {
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c2', 0.2]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    const job = makeLegacyJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'score:0', ok: true, response: { choices: [{ message: { content: 'enc' } }] } },
    ])));

    await reconcileAsyncJobResults('foreground');

    expect(mockSaveScoringResult).toHaveBeenCalledWith('c2', expect.objectContaining({ reasonSkipped: true }));
  });
});

describe('reconcileAsyncJobResults — relevance phase (phase-1)', () => {
  function makeRelevanceJob() {
    return makePendingJob({
      phase: 'relevance',
      candidateIds: ['c1', 'c2', 'c3'],
      callIds: ['score:0'],
      relevanceMap: undefined,
    });
  }

  function makeServerRelevanceResults() {
    return makeServerResults([
      { id: 'score:0', ok: true, response: { choices: [{ message: { content: 'enc-scores' } }] } },
    ]);
  }

  beforeEach(() => {
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c1', 0.9], ['c2', 0.8], ['c3', 0.1]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', titleEn: 'title', relatedFacts: [{}] },
      { id: 'c2', titleEn: 'title2', relatedFacts: [{}] },
    ]);
  });

  it('saves relevance for each candidate in phase-1 and transitions to unpacking-relevance', async () => {
    const job = makeRelevanceJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerRelevanceResults()));

    await reconcileAsyncJobResults('foreground');

    // setCycleState('unpacking-relevance') happens before the dynamic import
    expect(mockSetCycleState).toHaveBeenCalledWith('unpacking-relevance');
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c1', expect.objectContaining({ reason: '', reasonSkipped: false }));
  });

  it('skips candidateId in phase-1 when in failedIds (continue branch)', async () => {
    const job = makeRelevanceJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerRelevanceResults()));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c2', 0.9], ['c3', 0.1]]),
      reasonMap: new Map(),
      failedIds: new Set(['c1']),
    });

    await reconcileAsyncJobResults('foreground');

    // c1 is in failedIds so saveScoringResult should not be called for it
    expect(mockSaveScoringResult).not.toHaveBeenCalledWith('c1', expect.anything());
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c2', expect.anything());
  });

  it('skips candidateId in phase-1 when scoreMap has no entry (undefined branch)', async () => {
    const job = makeRelevanceJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerRelevanceResults()));
    // Only c2 has a score; c1 and c3 are undefined
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c2', 0.9]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });

    await reconcileAsyncJobResults('foreground');

    expect(mockSaveScoringResult).toHaveBeenCalledTimes(1);
    expect(mockSaveScoringResult).toHaveBeenCalledWith('c2', expect.anything());
  });

  it('ignores record-not-found errors when saving relevance (continues to next candidate)', async () => {
    const job = makeRelevanceJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerRelevanceResults()));
    mockSaveScoringResult.mockRejectedValueOnce(new Error('Record article_suggestions#c1 not found'));

    // Should not throw — record-not-found is swallowed
    await expect(reconcileAsyncJobResults('foreground')).resolves.toBeDefined();
    // Processing continues: c2 and c3 are still attempted
    expect(mockSaveScoringResult).toHaveBeenCalledTimes(3); // c1 (rejected), c2, c3
  });

  it('calls captureException for non-record-not-found save errors in phase-1', async () => {
    const job = makeRelevanceJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerRelevanceResults()));
    mockSaveScoringResult.mockRejectedValueOnce(new Error('Unexpected DB error in phase-1'));

    await reconcileAsyncJobResults('foreground');

    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('reconcileAsyncJobResults — single-flight guard', () => {
  it('returns same promise when called concurrently (second call gets first result)', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);

    const p1 = reconcileAsyncJobResults('foreground');
    const p2 = reconcileAsyncJobResults('foreground');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('completed');
    expect(r2).toBe('completed');
    expect(mockGetPendingAsyncJob).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileAsyncJobResults — requestId mismatch warning', () => {
  it('logs warning when requestId differs from pending', async () => {
    const job = makePendingJob({ requestId: 'req-actual' });
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));

    await reconcileAsyncJobResults('foreground', 'req-different');

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('requestId mismatch'),
    );
  });
});

describe('submitOrphanedReasonJob', () => {
  it('returns skipped-pending when a job is already pending', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('skipped-pending');
  });

  it('returns skipped-empty when no qualified candidates (all below threshold)', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.1 },
    ]);

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('skipped-empty');
  });

  it('returns skipped-empty when no candidates at all', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([]);

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('skipped-empty');
  });

  it('submits reason job for orphaned qualified candidates', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.9, titleEn: 'Title', relatedFacts: [{}] },
    ]);
    mockSendInferenceRequest.mockResolvedValue('orphan-req-1');

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('submitted');
    expect(mockSetCycleState).toHaveBeenCalledWith('waiting-for-reason');
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('reasons');
  });

  it('marks ineligible orphans as reason-skipped (batchMarkReasonSkipped called)', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.9 },
      { id: 'c2', relevance: 0.8 },
    ]);
    // Only c2 is eligible
    mockBuildReasonCallsForSubset.mockResolvedValue({
      calls: [{ id: 'reason:c2' }],
      eligibleCandidates: [{ id: 'c2' }],
    });
    mockSendInferenceRequest.mockResolvedValue('orphan-req-ineligible');

    // batchMarkReasonSkipped is called BEFORE the dynamic import
    await submitOrphanedReasonJob('foreground').catch(() => {});

    expect(mockBatchMarkReasonSkipped).toHaveBeenCalledWith(['c1']);
  });

  it('returns skipped-empty when no calls in reason bundle', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.9 },
    ]);
    mockBuildReasonCallsForSubset.mockResolvedValue({
      calls: [],
      eligibleCandidates: [{ id: 'c1' }],
    });

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('skipped-empty');
  });

  it('returns error when sendInferenceRequest returns null', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.9 },
    ]);
    mockSendInferenceRequest.mockResolvedValue(null);

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('error');
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('idle');
  });

  it('returns skipped-pending when CAS lost during placeholder write', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.9 },
    ]);
    mockSetPendingAsyncJob.mockRejectedValueOnce(new StaleError(null, 'other'));

    const result = await submitOrphanedReasonJob('foreground');

    expect(result).toBe('skipped-pending');
  });

  it('clears and ignores PendingJobStaleError when clearing placeholder after failed submit', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockGetScoredSuggestionsWithoutReasons.mockResolvedValue([
      { id: 'c1', relevance: 0.9 },
    ]);
    mockSendInferenceRequest.mockResolvedValue(null);
    mockClearPendingAsyncJob.mockRejectedValueOnce(new StaleError());

    // Should not throw - PendingJobStaleError is swallowed
    const result = await submitOrphanedReasonJob('foreground');
    expect(result).toBe('error');
  });
});

describe('reconcileAsyncJobResults — response body parsing edge cases', () => {
  it('handles unreadable response body on error status', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({
      status: 503,
      ok: false,
      text: jest.fn().mockRejectedValue(new Error('body read error')),
    });

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('error');
  });

  it('handles non-JSON response body on error status', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({
      status: 503,
      ok: false,
      text: jest.fn().mockResolvedValue('plain text error'),
    });

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('error');
  });

  it('handles reasoning_content field in response choices (decryptContent called)', async () => {
    const job = makePendingJob({ phase: 'reasons', callIds: ['reason:c1'] });
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      {
        id: 'reason:c1',
        ok: true,
        response: { choices: [{ message: { reasoning_content: 'enc-reasoning' } }] },
      },
    ])));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map([['c1', 'reason via reasoning_content']]),
      failedIds: new Set(),
    });

    await reconcileAsyncJobResults('foreground');

    // decryptContent is called before the dynamic import — observable
    expect(mockDecryptContent).toHaveBeenCalled();
  });

  it('handles toBatchResult with ok=false row (error field)', async () => {
    const job = makePendingJob({ phase: 'reasons', callIds: ['reason:c1'] });
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'reason:c1', ok: false, error: 'upstream error' },
    ])));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map(),
      failedIds: new Set(['c1']),
    });

    await reconcileAsyncJobResults('foreground');
    // No save called for failed row
    expect(mockSaveReason).not.toHaveBeenCalled();
  });

  it('handles toBatchResult with empty content (no choice message)', async () => {
    const job = makePendingJob({ phase: 'reasons', callIds: ['reason:c1'] });
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'reason:c1', ok: true, response: { choices: [{ message: {} }] } },
    ])));
    // Empty content → no decryptContent call
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map(),
      failedIds: new Set(),
    });

    await reconcileAsyncJobResults('foreground');
    expect(mockDecryptContent).not.toHaveBeenCalled();
  });

  it('handles toBatchResult decrypt error gracefully (returns error in output)', async () => {
    const job = makePendingJob({ phase: 'reasons', callIds: ['reason:c1'] });
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'reason:c1', ok: true, response: { choices: [{ message: { content: 'enc' } }] } },
    ])));
    mockDecryptContent.mockImplementationOnce(() => { throw new Error('decrypt failed'); });
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(),
      reasonMap: new Map(),
      failedIds: new Set(),
    });

    // Should not throw — decrypt error is caught inside toBatchResult
    await expect(reconcileAsyncJobResults('foreground')).resolves.toBeDefined();
  });
});

describe('reconcileAsyncJobResults — reason phase additional branches', () => {
  it('legacy flow: captures exception for non-record-not-found saveScoringResult errors', async () => {
    const legacyJob = {
      ...makePendingJob(),
      phase: undefined as any,
      candidateIds: ['c1'],
      callIds: ['score:0'],
      relevanceMap: undefined,
      idempotencyKey: undefined,
    };
    mockGetPendingAsyncJob.mockResolvedValue(legacyJob);
    mockExpoFetch.mockResolvedValue(makeFetchResponse(makeServerResults([
      { id: 'score:0', ok: true, response: { choices: [{ message: { content: 'enc' } }] } },
    ])));
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['c1', 0.9]]),
      reasonMap: new Map([['c1', 'reason']]),
      failedIds: new Set(),
    });
    mockSaveScoringResult.mockRejectedValueOnce(new Error('Unexpected DB error'));

    await reconcileAsyncJobResults('foreground');

    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('reconcileAsyncJobResults — clearPendingAsyncJob error in stale path', () => {
  it('logs but does not throw when clearPendingAsyncJob fails in stale-job path', async () => {
    const staleJob = makePendingJob({ submittedAt: NOW - 2 * 60 * 60 * 1000 });
    mockGetPendingAsyncJob.mockResolvedValue(staleJob);
    mockClearPendingAsyncJob.mockRejectedValueOnce(new Error('db error clearing stale'));

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('logs but does not throw when clearPendingAsyncJob fails in not-found path', async () => {
    const job = makePendingJob();
    mockGetPendingAsyncJob.mockResolvedValue(job);
    mockExpoFetch.mockResolvedValue({ status: 404, ok: false, text: jest.fn() });
    mockClearPendingAsyncJob.mockRejectedValueOnce(new Error('db error clearing not-found'));

    const result = await reconcileAsyncJobResults('foreground');

    expect(result).toBe('stale');
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

// NOTE: This empty export ensures this file is treated as a module
export {};
