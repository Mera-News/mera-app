// scoring-pipeline.test.ts — orchestrator tests for the pipelined multi-batch
// cloud scoring flow. sendInferenceRequest, fetchResults, the DB services, and
// the store refresh are all mocked. The scoring-pipeline-store is replaced with
// a faithful in-memory
// implementation so createPipeline / getPipeline / mutatePipeline / clearPipeline
// behave (CAS + deep-copy) like the real thing.

// ---- shared mock fns ----
const mockTryTakeImmediate = jest.fn();
const mockPauseFor = jest.fn();
const mockAcquire = jest.fn().mockResolvedValue(undefined);
const mockSendInferenceRequest = jest.fn();
const mockBytesToHex = jest.fn((..._args: any[]) => 'aabbccdd');
const mockPrepareE2EEContext = jest.fn();
const mockRebuildE2EEContext = jest.fn();
const mockGetUnscored = jest.fn();
const mockCountUnscoredSuggestions = jest.fn();
const mockGetOldestUnscoredCreatedAt = jest.fn();
const mockGetScoredWithoutReasons = jest.fn();
const mockSaveScoringResult = jest.fn();
const mockSaveReason = jest.fn();
const mockBatchMarkReasonSkipped = jest.fn();
const mockBatchSaveMathScores = jest.fn();
const mockGetComputedComponentsByIds = jest.fn((..._args: any[]) => Promise.resolve(new Map()));
// Round-3: per-fact enqueue grouping + advisory-judge calibration deps.
const mockLoadSectionSnapshots = jest.fn((..._args: any[]) =>
  Promise.resolve({
    topics: new Map(),
    facts: new Map(),
    locations: new Map(),
    factStatements: new Map(),
    hasTopics: false,
  }),
);
const mockBuildJudgeCalls = jest.fn();
const mockDecodeJudgeResults = jest.fn();
const mockBuildCalibrationCase = jest.fn((...args: any[]) => ({
  id: args[0],
  computed: args[1],
  judge: args[2],
}));
const mockRecordOverrides = jest.fn((..._args: any[]) =>
  Promise.resolve({ count: 0, notified: false }),
);
// Persona-v3: computeMathStage runs at submit. Default = ALL backstop so the
// pipeline takes the legacy relevance+reasons path these tests already assert;
// individual judge-mode tests override this to return math-mode candidates.
const mockComputeMathStage = jest.fn(async (candidates: any[] = []) => ({
  persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
  stage: candidates.map((c) => ({ input: { id: c.id } })),
  computedScoreMap: new Map(),
  componentsMap: new Map(),
  modeMap: new Map(candidates.map((c) => [c.id, 'backstop'])),
}));
const mockBucketScores = jest.fn();
const mockBuildRelevanceCalls = jest.fn();
const mockBuildReasonCallsForSubset = jest.fn();
const mockDecodeResults = jest.fn();
// Verifier is a no-op in these orchestrator tests (its own unit tests cover
// behaviour) — returns 0 demoted, leaving the decoded scoreMap untouched.
const mockRunFeedVerifierPass = jest.fn().mockResolvedValue(0);
const mockRefresh = jest.fn();
const mockFetchResults = jest.fn();
const mockDiscardLowRelevance = jest.fn();
const mockToBatchResult = jest.fn((...args: any[]) => ({ id: args[0].id, output: 'out' }));
const mockReconstructLookups = jest.fn((..._args: any[]) => ({ chunkIdToCandidates: new Map() }));
const mockGetExpoPushToken = jest.fn(() => 'ExponentPushToken[test]');
const mockSetAsyncJobPhase = jest.fn();
const mockSetBatchProgress = jest.fn();
const mockMarkProcessingRunFinished = jest.fn();

// ---- AppState (react-native) ----
let mockAppStateCurrent: string = 'active';
const mockAppStateAddListener = jest.fn((..._args: any[]) => ({ remove: jest.fn() }));
jest.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mockAppStateCurrent;
    },
    addEventListener: (...args: any[]) => mockAppStateAddListener(...args),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

jest.mock('@/lib/llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));

jest.mock('@/lib/llm/gateway-rate-limiter', () => ({
  tryTakeImmediate: (...args: any[]) => mockTryTakeImmediate(...args),
  pauseFor: (...args: any[]) => mockPauseFor(...args),
  acquire: (...args: any[]) => mockAcquire(...args),
}));

jest.mock('@/lib/llm/submitInferenceJob', () => ({
  sendInferenceRequest: (...args: any[]) => mockSendInferenceRequest(...args),
  bytesToHex: (...args: any[]) => mockBytesToHex(...args),
}));

jest.mock('@/lib/e2ee/e2ee-service', () => ({
  prepareE2EEContext: (...args: any[]) => mockPrepareE2EEContext(...args),
  rebuildE2EEContext: (...args: any[]) => mockRebuildE2EEContext(...args),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscored(...args),
  countUnscoredSuggestions: (...args: any[]) => mockCountUnscoredSuggestions(...args),
  getOldestUnscoredCreatedAt: (...args: any[]) => mockGetOldestUnscoredCreatedAt(...args),
  getScoredSuggestionsWithoutReasons: (...args: any[]) => mockGetScoredWithoutReasons(...args),
  saveScoringResult: (...args: any[]) => mockSaveScoringResult(...args),
  saveReason: (...args: any[]) => mockSaveReason(...args),
  batchMarkReasonSkipped: (...args: any[]) => mockBatchMarkReasonSkipped(...args),
  batchSaveMathScores: (...args: any[]) => mockBatchSaveMathScores(...args),
  getComputedComponentsByIds: (...args: any[]) => mockGetComputedComponentsByIds(...args),
}));

// Round-3: fact-grouping snapshot loader (lazy-required in planFactBatches).
jest.mock('@/lib/stores/section-snapshots', () => ({
  loadSectionSnapshots: (...args: any[]) => mockLoadSectionSnapshots(...args),
}));

// Round-3: advisory-judge decode + calibration.
jest.mock('@/lib/news-harness/scoring-engine', () => ({
  buildJudgeCalls: (...args: any[]) => mockBuildJudgeCalls(...args),
  decodeJudgeResults: (...args: any[]) => mockDecodeJudgeResults(...args),
  buildCalibrationCase: (...args: any[]) => mockBuildCalibrationCase(...args),
}));

jest.mock('@/lib/database/services/calibration-service', () => ({
  recordOverrides: (...args: any[]) => mockRecordOverrides(...args),
}));

// stage-scoring pulls in the persona DB services + auth chain at import time;
// mock it so the pipeline module loads without native deps. Default drives the
// legacy backstop path (see mockComputeMathStage above).
jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  computeMathStage: (...args: any[]) => mockComputeMathStage(...args),
}));

jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  bucketScores: (...args: any[]) => mockBucketScores(...args),
  buildRelevanceCalls: (...args: any[]) => mockBuildRelevanceCalls(...args),
  buildReasonCallsForSubset: (...args: any[]) => mockBuildReasonCallsForSubset(...args),
  decodeResults: (...args: any[]) => mockDecodeResults(...args),
  runFeedVerifierPass: (...args: any[]) => mockRunFeedVerifierPass(...args),
  CLOUD_SCORE_CHUNK_SIZE: 5,
  REASON_MIN_RAW_SCORE: 0.3,
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: {
    getState: jest.fn(() => ({
      userPersona: { expoPushToken: mockGetExpoPushToken() },
    })),
  },
}));

jest.mock('@/lib/services/SuggestionSyncService', () => ({
  refreshSuggestionsInStoreUnsafe: (...args: any[]) => mockRefresh(...args),
}));

// For-You header store — the pipeline pushes derived phase/progress here as
// batches transition (pushUiProgress).
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: () => ({
      setAsyncJobPhase: mockSetAsyncJobPhase,
      setBatchProgress: mockSetBatchProgress,
      markProcessingRunFinished: mockMarkProcessingRunFinished,
    }),
  },
}));

jest.mock('@/lib/services/inference-results', () => ({
  discardLowRelevance: (...args: any[]) => mockDiscardLowRelevance(...args),
  fetchResults: (...args: any[]) => mockFetchResults(...args),
  hexToBytes: () => new Uint8Array([1, 2, 3, 4]),
  isRecordNotFoundError: (err: unknown) =>
    /Record\s+\S+\s+not\s+found/i.test(err instanceof Error ? err.message : String(err)),
  reconstructLookups: (...args: any[]) => mockReconstructLookups(...args),
  toBatchResult: (...args: any[]) => mockToBatchResult(...args),
  REASON_RELEVANCE_THRESHOLD: 0.3,
}));

// ---- in-memory scoring-pipeline-store ----
let mockRun: any = null;
let mockPrivKeyHex: string | null = null;

jest.mock('@/lib/database/services/scoring-pipeline-store', () => ({
  createPipeline: jest.fn(async (run: any, privKeyHex: string) => {
    if (mockRun) throw new Error('A pipeline run already exists');
    mockRun = { ...run, schema: 1, version: 1 };
    mockPrivKeyHex = privKeyHex;
  }),
  getPipeline: jest.fn(async () =>
    mockRun
      ? { run: JSON.parse(JSON.stringify(mockRun)), privKeyHex: mockPrivKeyHex }
      : null,
  ),
  mutatePipeline: jest.fn(async (mutator: (run: any) => any) => {
    if (!mockRun) return 'no-run';
    const draft = JSON.parse(JSON.stringify(mockRun));
    const result = mutator(draft);
    if (result === null) return 'aborted';
    draft.version = mockRun.version + 1;
    mockRun = draft;
    return { result, run: draft };
  }),
  clearPipeline: jest.fn(async () => {
    mockRun = null;
    mockPrivKeyHex = null;
  }),
}));

import {
  enqueueCandidates,
  enqueueOrphanedReasons,
  handlePush,
  pollTick,
  recover,
  abortRun,
  getPipelineStatus,
  derivePipelineUiState,
  getPipelineUiState,
  derivePipelineBatchProgress,
  _resetForTests,
  BATCH_SIZE,
  MAX_UNSCORED_WAIT_MS,
} from '@/lib/services/scoring-pipeline';
import type { PipelineRun } from '@/lib/database/services/scoring-pipeline-store';

// ---- helpers ----
const NOW = 1_700_000_000_000;

function currentRun(): any {
  return mockRun;
}

function candidate(id: string) {
  return {
    id,
    titleEn: 'title',
    descriptionEn: 'desc',
    countryCode: null,
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: 'fact' }],
  };
}

function ids(n: number, prefix = 'id'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

let reqCounter = 0;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockRun = null;
  mockPrivKeyHex = null;
  mockAppStateCurrent = 'active';
  reqCounter = 0;
  _resetForTests();

  mockTryTakeImmediate.mockReturnValue(true);
  mockGetExpoPushToken.mockReturnValue('ExponentPushToken[test]');
  mockPrepareE2EEContext.mockResolvedValue({
    privateKey: new Uint8Array([1, 2, 3, 4]),
    algo: 'ed25519',
    headers: {},
    modelPubKeyHex: 'cc',
    clientPubKeyHex: 'aa',
  });
  mockRebuildE2EEContext.mockResolvedValue({
    privateKey: new Uint8Array([1, 2, 3, 4]),
    algo: 'ed25519',
    headers: {},
    modelPubKeyHex: 'cc',
    clientPubKeyHex: 'aa',
  });
  mockSendInferenceRequest.mockImplementation(async () => ({
    status: 'ok',
    requestId: `req-${reqCounter++}`,
    capabilityToken: `cap-${reqCounter}`,
  }));
  // getUnscored returns a candidate for every id currently held by a batch in
  // the run — the orchestrator filters to the batch's own candidateIds, so this
  // guarantees every enqueued id is "unscored".
  mockGetUnscored.mockImplementation(async () => {
    const all = new Set<string>();
    if (mockRun) {
      for (const b of mockRun.batches) for (const id of b.candidateIds) all.add(id);
    }
    return Array.from(all).map((id) => candidate(id));
  });
  // Default: the oldest unscored row is well past MAX_UNSCORED_WAIT_MS, so the
  // staleness escape fires and a trailing partial (<25) quantum still dispatches.
  // This keeps every test that enqueues a small (<25) id set exercising the
  // pipeline; the deferral-specific tests override this to a fresh timestamp.
  mockCountUnscoredSuggestions.mockResolvedValue(BATCH_SIZE + 100);
  mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW - MAX_UNSCORED_WAIT_MS - 1_000);
  mockGetScoredWithoutReasons.mockResolvedValue([]);
  mockSaveScoringResult.mockResolvedValue(undefined);
  mockSaveReason.mockResolvedValue(undefined);
  mockBatchMarkReasonSkipped.mockResolvedValue(undefined);
  mockBucketScores.mockImplementation(() => undefined); // no-op: raw == bucketed
  mockBuildRelevanceCalls.mockImplementation(async (subset: any[]) => ({
    calls: Array.from(
      { length: Math.max(1, Math.ceil(subset.length / 5)) },
      (_, i) => ({ id: `score:${i}`, system: 's', prompt: 'p' }),
    ),
    eligibleCandidates: subset,
    promptsById: new Map(),
    chunkIdToCandidates: new Map(),
  }));
  mockBuildReasonCallsForSubset.mockImplementation(async (subset: any[]) => ({
    calls: subset.map((c) => ({ id: `reason:${c.id}`, system: 's', prompt: 'p' })),
    eligibleCandidates: subset,
    promptsById: new Map(),
    chunkIdToCandidates: new Map(),
  }));
  mockDecodeResults.mockReturnValue({
    scoreMap: new Map(),
    reasonMap: new Map(),
    failedIds: new Set(),
  });
  mockDiscardLowRelevance.mockResolvedValue(0);
  mockRefresh.mockResolvedValue(undefined);
  mockBatchSaveMathScores.mockResolvedValue(undefined);
  mockGetComputedComponentsByIds.mockResolvedValue(new Map());
  mockLoadSectionSnapshots.mockResolvedValue({
    topics: new Map(),
    facts: new Map(),
    locations: new Map(),
    factStatements: new Map(),
    hasTopics: false,
  });
  mockRecordOverrides.mockResolvedValue({ count: 0, notified: false });
  mockBuildCalibrationCase.mockImplementation((id: string, computed: number, judge: number) => ({
    id,
    computed,
    judge,
  }));
});

afterEach(() => {
  _resetForTests();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('enqueueCandidates', () => {
  it('creates a run and submits up to MAX_IN_FLIGHT batches', async () => {
    await enqueueCandidates(ids(100)); // 4 batches of 25

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(4);
    const waiting = run.batches.filter((b: any) => b.phase === 'waiting-relevance');
    const queued = run.batches.filter((b: any) => b.phase === 'queued');
    expect(waiting).toHaveLength(3);
    expect(queued).toHaveLength(1);
    expect(mockSendInferenceRequest).toHaveBeenCalledTimes(3);
    // distinct requestIds
    const reqIds = waiting.map((b: any) => b.requestId);
    expect(new Set(reqIds).size).toBe(3);
    // one keypair minted for the run
    expect(mockPrepareE2EEContext).toHaveBeenCalledTimes(1);
  });

  it('dedups ids already in a non-terminal batch on re-enqueue', async () => {
    await enqueueCandidates(ids(50)); // 2 batches
    const before = currentRun().batches.length;
    mockSendInferenceRequest.mockClear();

    await enqueueCandidates(ids(50)); // identical ids

    expect(currentRun().batches.length).toBe(before);
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('attaches the push token only to the last relevance submit', async () => {
    // 2 batches, both admitted (MAX_IN_FLIGHT >= 2).
    await enqueueCandidates(ids(50));

    // batch 0 submitted while batch 1 still queued → no token.
    // batch 1 submitted last → token attached.
    const call0 = mockSendInferenceRequest.mock.calls[0][0];
    const call1 = mockSendInferenceRequest.mock.calls[1][0];
    expect(call0.token).toBeNull();
    expect(call1.token).toBe('ExponentPushToken[test]');
  });

  it('requeues without burning an attempt when a submit is throttled', async () => {
    mockTryTakeImmediate.mockReturnValueOnce(true).mockReturnValue(false);
    mockSendInferenceRequest.mockResolvedValueOnce({ status: 'throttled' });

    await enqueueCandidates(ids(25)); // 1 batch

    const b = currentRun().batches[0];
    expect(b.phase).toBe('queued');
    expect(b.attempt).toBe(0);
    expect(mockSendInferenceRequest).toHaveBeenCalledTimes(1);
  });

  it('fails a batch after two failed submits without writing any scores; siblings unaffected', async () => {
    mockSendInferenceRequest
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValue({ status: 'ok', requestId: 'req-b1', capabilityToken: 'cap' });

    await enqueueCandidates(ids(50)); // 2 batches

    const run = currentRun();
    const b0 = run.batches[0];
    const b1 = run.batches[1];
    expect(b0.phase).toBe('failed');
    expect(b0.failureReason).toBe('submit-failed');
    expect(b1.phase).toBe('waiting-relevance');
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
    expect(mockSendInferenceRequest).toHaveBeenCalledTimes(3);
  });
});

describe('enqueueCandidates: strict quantum gate', () => {
  it('defers a sub-25 quantum when the oldest unscored row is fresh (no run created)', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // age 0 — no escape

    await enqueueCandidates(ids(5)); // 5 < BATCH_SIZE → trailing partial → deferred

    expect(currentRun()).toBeNull();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('dispatches exactly floor(n/25) full quanta and defers the remainder (run creation)', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh — no escape for the partial

    await enqueueCandidates(ids(30)); // 30 = 1 full quantum (25) + 5 deferred

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(BATCH_SIZE);
  });

  it('dispatches a sub-25 partial once the oldest unscored row exceeds MAX_UNSCORED_WAIT_MS (escape)', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW - MAX_UNSCORED_WAIT_MS - 1_000);

    await enqueueCandidates(ids(3));

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(3);
  });

  it('applies the SAME quantum rule to appends: 30 fresh with an active run → one 25-batch appended, 5 deferred', async () => {
    // Establish an active run with one full quantum.
    await enqueueCandidates(ids(25, 'seed'));
    const before = currentRun().batches.length;
    expect(before).toBe(1);

    // Fresh oldest → the trailing partial must defer even on an append.
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);

    await enqueueCandidates(ids(30, 'more')); // 1 full quantum appended, 5 deferred

    const run = currentRun();
    expect(run.batches).toHaveLength(before + 1);
    const appended = run.batches[run.batches.length - 1];
    expect(appended.candidateIds).toHaveLength(BATCH_SIZE);
  });

  it('enqueueOrphanedReasons is ungated by the quantum rule', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);
    mockGetScoredWithoutReasons.mockResolvedValue([
      { ...candidate('o0'), relevance: 0.8 },
    ]);

    await enqueueOrphanedReasons();

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].reasonsOnly).toBe(true);
  });
});

describe('relevance completion', () => {
  async function setupOneWaitingRelevanceBatch(batchIds: string[]) {
    await enqueueCandidates(batchIds);
    const batch = currentRun().batches[0];
    expect(batch.phase).toBe('waiting-relevance');
    return batch;
  }

  it('saves scores, refreshes UI, and submits reasons in the same cycle when impactful rows exist', async () => {
    const batch = await setupOneWaitingRelevanceBatch(['a0', 'a1']);
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.8], ['a1', 0.2]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    // impactful subset (a0) is scored-without-reasons for the reasons submit.
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValue({ requestId: batch.requestId, results: [{ id: 'score:0', ok: true }] });
    mockSendInferenceRequest.mockClear();
    mockSendInferenceRequest.mockResolvedValue({ status: 'ok', requestId: 'reasons-req', capabilityToken: 'cap-r' });

    await handlePush(batch.requestId, 'foreground');

    expect(mockSaveScoringResult).toHaveBeenCalledWith('a0', expect.objectContaining({ relevance: 0.8, reason: '' }));
    expect(mockSaveScoringResult).toHaveBeenCalledWith('a1', expect.objectContaining({ relevance: 0.2 }));
    expect(mockRefresh).toHaveBeenCalled();
    // reasons job submitted this cycle, carrying the relevance job's capability
    // token (harmless JWT-first fallback in foreground)
    expect(mockSendInferenceRequest).toHaveBeenCalledTimes(1);
    expect(mockSendInferenceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'foreground',
        capabilityToken: batch.capabilityToken,
      }),
    );
    const b = currentRun().batches[0];
    expect(b.phase).toBe('waiting-reasons');
    expect(b.requestId).toBe('reasons-req');
  });

  it('completes without a reasons job when nothing is impactful', async () => {
    const batch = await setupOneWaitingRelevanceBatch(['a0', 'a1']);
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.2], ['a1', 0.1]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({ requestId: batch.requestId, results: [{ id: 'score:0', ok: true }] });
    mockSendInferenceRequest.mockClear();

    await handlePush(batch.requestId, 'foreground');

    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    expect(mockDiscardLowRelevance).toHaveBeenCalled();
    // single batch → run finalized + cleared
    expect(currentRun()).toBeNull();
  });

  it('admits the next queued batch after a batch completes', async () => {
    await enqueueCandidates(ids(100)); // 4 batches: 3 waiting, 1 queued
    const b0 = currentRun().batches[0];
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['id0', 0.1]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({ requestId: b0.requestId, results: [{ id: 'score:0', ok: true }] });

    await handlePush(b0.requestId, 'foreground');

    const run = currentRun();
    expect(run.batches[0].phase).toBe('done');
    // the previously-queued 4th batch is now in flight
    expect(run.batches[3].phase).toBe('waiting-relevance');
  });

  it('never writes scores for a relevance batch whose fetch 404s (persists nothing)', async () => {
    // MAX_BATCH_ATTEMPTS reached on a waiting-relevance batch → failed, no scores.
    const batch = await setupOneWaitingRelevanceBatch(['a0']);
    // First 404 requeues to queued; re-submit → waiting; advance time; 404 again → fail.
    mockFetchResults.mockResolvedValue('not-found');

    await handlePush(batch.requestId, 'foreground'); // attempt 1 → requeued to queued, re-drained → waiting again
    // find the new requestId
    const b1 = currentRun().batches[0];
    jest.setSystemTime(NOW + 20_000);
    await handlePush(b1.requestId, 'foreground'); // attempt 2 → failed

    const finalBatch = currentRun()?.batches[0];
    // single failed batch finalizes + clears the run
    expect(finalBatch === undefined || finalBatch.phase === 'failed').toBe(true);
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
  });
});

describe('reasons completion', () => {
  it('saves reasons, discards low-relevance, marks done', async () => {
    // Build a single batch already in waiting-reasons via the relevance path.
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValueOnce({ requestId: batch.requestId, results: [{ id: 'score:0', ok: true }] });
    await handlePush(batch.requestId, 'foreground'); // → waiting-reasons

    const reasonsBatch = currentRun().batches[0];
    expect(reasonsBatch.phase).toBe('waiting-reasons');

    // Now complete the reasons job.
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(),
      reasonMap: new Map([['a0', 'because it matters']]),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValueOnce({ requestId: reasonsBatch.requestId, results: [{ id: 'reason:a0', ok: true }] });

    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'because it matters');
    expect(mockDiscardLowRelevance).toHaveBeenCalled();
    // single batch → finalized + cleared
    expect(currentRun()).toBeNull();
  });

  it('marks the batch done (scores kept) when the reasons submit fails', async () => {
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValueOnce({ requestId: batch.requestId, results: [{ id: 'score:0', ok: true }] });
    // reasons submit fails
    mockSendInferenceRequest.mockResolvedValueOnce({ status: 'failed' });

    await handlePush(batch.requestId, 'foreground');

    // scores were saved before the reasons submit
    expect(mockSaveScoringResult).toHaveBeenCalledWith('a0', expect.objectContaining({ relevance: 0.8 }));
    // batch ends done (not failed); single batch → finalized + cleared
    expect(currentRun()).toBeNull();
  });
});

describe('enqueueOrphanedReasons', () => {
  it('appends reasonsOnly batches for qualified scored-without-reason rows', async () => {
    mockGetScoredWithoutReasons.mockResolvedValue([
      { ...candidate('o0'), relevance: 0.8 },
      { ...candidate('o1'), relevance: 0.1 }, // below threshold → excluded
    ]);

    await enqueueOrphanedReasons();

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].reasonsOnly).toBe(true);
    expect(run.batches[0].candidateIds).toEqual(['o0']);
    // submitted as a reasons job
    expect(mockBuildReasonCallsForSubset).toHaveBeenCalled();
    expect(run.batches[0].phase).toBe('waiting-reasons');
  });
});

describe('stale pending', () => {
  it('requeues a waiting batch whose job has been pending past BATCH_STALE_MS', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockResolvedValue('pending');

    // Advance beyond BATCH_STALE_MS (15 min) so the pending job is stale.
    jest.setSystemTime(NOW + 16 * 60_000);
    // Re-drain is blocked (in-flight), so the batch just requeues on poll.
    mockSendInferenceRequest.mockClear();
    await pollTick('foreground');

    const b = currentRun().batches[0];
    // attempt 1 (< MAX) → requeued to queued then re-drained → back in flight
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(b.phase);
    expect(b.attempt).toBe(1);
  });
});

describe('throwing /results fetch (catch-path staleness)', () => {
  it('requeues/fails a waiting batch past BATCH_STALE_MS when the fetch throws', async () => {
    await enqueueCandidates(['a0']);
    // A THROWING /results fetch (5xx / network) — previously left the batch in
    // waiting-* untouched forever; the catch path now applies BATCH_STALE_MS.
    mockFetchResults.mockRejectedValue(new Error('network 5xx'));

    // Advance beyond BATCH_STALE_MS (15 min) so the waiting batch is over-age.
    jest.setSystemTime(NOW + 16 * 60_000);
    mockSendInferenceRequest.mockClear();
    await pollTick('foreground');

    const b = currentRun().batches[0];
    // attempt 1 (< MAX) → requeued to queued then re-drained → back in flight
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(b.phase);
    expect(b.attempt).toBe(1);
  });

  it('leaves a waiting batch younger than BATCH_STALE_MS untouched when the fetch throws', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockRejectedValue(new Error('network blip'));

    // Past MIN_POLL_AGE (15s) so pollTick actually polls, but well under
    // BATCH_STALE_MS — the throw is logged and the batch is left alone.
    jest.setSystemTime(NOW + 30_000);
    await pollTick('foreground');

    const b = currentRun().batches[0];
    expect(b.phase).toBe('waiting-relevance');
    expect(b.attempt).toBe(0);
  });
});

describe('abortRun', () => {
  it('force-fails non-terminal batches, finalizes + clears the run, and stamps markProcessingRunFinished', async () => {
    await enqueueCandidates(ids(50)); // 2 waiting-relevance (non-terminal) batches
    expect(currentRun()).not.toBeNull();
    mockMarkProcessingRunFinished.mockClear();

    await abortRun('cache-clear');

    // run force-failed → finalized → cleared
    expect(currentRun()).toBeNull();
    expect(mockMarkProcessingRunFinished).toHaveBeenCalled();
  });

  it('still stamps markProcessingRunFinished when no run exists', async () => {
    expect(currentRun()).toBeNull();

    await abortRun('cache-clear');

    expect(currentRun()).toBeNull();
    expect(mockMarkProcessingRunFinished).toHaveBeenCalled();
  });
});

describe('recover', () => {
  it('returns idle when there is no run', async () => {
    expect(await recover()).toBe('idle');
  });

  it('reverts stuck submitters and resumes a live run', async () => {
    await enqueueCandidates(['a0']);
    // Force the batch into a stuck submitting-relevance state directly.
    mockRun.batches[0].phase = 'submitting-relevance';
    mockRun.batches[0].submittedAt = NOW - 120_000; // > SUBMIT_STUCK_MS old
    mockRun.batches[0].requestId = undefined;
    mockSendInferenceRequest.mockClear();

    const result = await recover();

    expect(result).toBe('running');
    // reverted then re-drained → back in flight (or at least not stuck-submitting)
    const b = currentRun().batches[0];
    expect(b.attempt).toBeGreaterThanOrEqual(1);
    expect(b.phase).not.toBe('submitting-relevance');
  });

  it('abandons a run older than RUN_ABANDON_MS and finalizes', async () => {
    await enqueueCandidates(['a0']);
    mockRun.startedAt = NOW - 25 * 3600_000; // > 24h

    const result = await recover();

    expect(result).toBe('idle');
    expect(currentRun()).toBeNull(); // finalized + cleared
  });
});

describe('handlePush', () => {
  it('checks only the batch matching the requestId', async () => {
    await enqueueCandidates(ids(50)); // 2 batches, both waiting
    const run = currentRun();
    const target = run.batches[1];
    mockFetchResults.mockResolvedValue('pending');

    await handlePush(target.requestId, 'foreground');

    expect(mockFetchResults).toHaveBeenCalledTimes(1);
    expect(mockFetchResults).toHaveBeenCalledWith(
      target.requestId,
      'foreground',
      expect.anything(),
    );
  });

  it('falls back to a full pollTick when the requestId is unknown', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockResolvedValue('pending');
    // batch is younger than MIN_POLL_AGE → pollTick polls nothing
    await handlePush('nonexistent-req', 'foreground');
    expect(mockFetchResults).not.toHaveBeenCalled();
  });
});

describe('background auth (per-batch capability token)', () => {
  it('background handlePush chains the reasons submit with the batch capability token', async () => {
    // Set up (foreground) a single waiting-relevance batch with a stored token.
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];
    expect(batch.capabilityToken).toBeTruthy();

    mockAppStateCurrent = 'background';
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValue({ requestId: batch.requestId, results: [{ id: 'score:0', ok: true }] });
    mockSendInferenceRequest.mockClear();
    mockSendInferenceRequest.mockResolvedValue({ status: 'ok', requestId: 'bg-reasons-req', capabilityToken: 'cap-bg-r' });

    await handlePush(batch.requestId, 'background');

    // The chained reasons submit ran in background and carried the completed
    // relevance job's capability token (jobs:submit-followup scope).
    expect(mockSendInferenceRequest).toHaveBeenCalledTimes(1);
    expect(mockSendInferenceRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'background',
        capabilityToken: batch.capabilityToken,
      }),
    );
    expect(currentRun().batches[0].phase).toBe('waiting-reasons');
  });

  it('background drain does not admit queued batches (deferred to foreground)', async () => {
    await enqueueCandidates(ids(100)); // 4 batches: 3 waiting-relevance, 1 queued
    const b0 = currentRun().batches[0];
    expect(currentRun().batches[3].phase).toBe('queued');

    // Complete batch 0 from a background wake (all sub-threshold → done, no
    // reasons job) — afterTerminal drains with background context.
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['id0', 0.1]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({ requestId: b0.requestId, results: [{ id: 'score:0', ok: true }] });
    mockSendInferenceRequest.mockClear();

    await handlePush(b0.requestId, 'background');

    const run = currentRun();
    expect(run.batches[0].phase).toBe('done');
    // The queued batch was NOT admitted — fresh submits have no capability
    // token in background; it waits for the next foreground tick.
    expect(run.batches[3].phase).toBe('queued');
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();

    // Foreground tick picks it up.
    await pollTick('foreground');
    await recover();
    expect(currentRun().batches[3].phase).toBe('waiting-relevance');
  });
});

describe('getPipelineStatus', () => {
  it('is idle with no run and running with a live batch', async () => {
    expect(await getPipelineStatus()).toBe('idle');
    await enqueueCandidates(['a0']);
    expect(await getPipelineStatus()).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// UI header progress projection (derivePipelineUiState / getPipelineUiState)
// + the live push into the For-You store.
// ---------------------------------------------------------------------------

function makeRun(batches: any[]): PipelineRun {
  return {
    schema: 1,
    runId: 'run-test',
    startedAt: NOW,
    algo: 'ed25519',
    expoPushToken: null,
    batches: batches.map((b, i) => ({ batchId: i, attempt: 0, ...b })),
    version: 1,
  };
}

describe('derivePipelineUiState', () => {
  it('is relevance while any batch still owes a relevance round', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'waiting-relevance', candidateIds: ['a', 'b'] },
        { phase: 'done', candidateIds: ['c'] },
      ]),
    );
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(1); // done batch only — relevance still pending on the other
    expect(ui.totalCount).toBe(3);
  });

  it('counts relevance-known batches (needs-reasons-submit/submitting-reasons/waiting-reasons) as processed even before terminal', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'waiting-reasons', candidateIds: ['a', 'b'] },
        { phase: 'needs-reasons-submit', candidateIds: ['c'] },
        { phase: 'submitting-reasons', candidateIds: ['e'] },
        { phase: 'done', candidateIds: ['d'] },
      ]),
    );
    expect(ui.phase).toBe('reasons');
    // Every batch here has relevance known (past the pre-relevance phases) —
    // the numerator should equal the denominator even though 3 of 4 batches
    // are still non-terminal.
    expect(ui.processedCount).toBe(5);
    expect(ui.totalCount).toBe(5);
  });

  it('does NOT count queued/submitting-relevance/waiting-relevance batches as processed', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'queued', candidateIds: ['a'] },
        { phase: 'submitting-relevance', candidateIds: ['b'] },
        { phase: 'waiting-relevance', candidateIds: ['c'] },
      ]),
    );
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(0);
    expect(ui.totalCount).toBe(3);
  });

  it('counts a failed (terminal) batch as processed so progress cannot stall below total', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'failed', candidateIds: ['a', 'b'] },
        { phase: 'waiting-relevance', candidateIds: ['c'] },
      ]),
    );
    expect(ui.processedCount).toBe(2);
    expect(ui.totalCount).toBe(3);
  });

  it('treats a queued reasonsOnly batch as reasons work (not relevance) and counts it immediately', () => {
    const ui = derivePipelineUiState(
      makeRun([{ phase: 'queued', reasonsOnly: true, candidateIds: ['a'] }]),
    );
    expect(ui.phase).toBe('reasons');
    expect(ui.processedCount).toBe(1);
    expect(ui.totalCount).toBe(1);
  });

  it('counts a submitting-relevance reasonsOnly batch as processed immediately (reasonsOnly never owes a relevance round)', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'submitting-reasons', reasonsOnly: true, candidateIds: ['a', 'b'] },
      ]),
    );
    expect(ui.processedCount).toBe(2);
    expect(ui.totalCount).toBe(2);
  });

  it('is idle when every batch is terminal', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'done', candidateIds: ['a'] },
        { phase: 'failed', candidateIds: ['b', 'c'] },
      ]),
    );
    expect(ui).toEqual({ phase: 'idle', processedCount: 0, totalCount: 0 });
  });
});

describe('getPipelineUiState', () => {
  it('returns idle when there is no run', async () => {
    expect(await getPipelineUiState()).toEqual({
      phase: 'idle',
      processedCount: 0,
      totalCount: 0,
    });
  });

  it('projects the persisted run', async () => {
    await enqueueCandidates(ids(50)); // 2 batches, both waiting-relevance
    const ui = await getPipelineUiState();
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(0);
    expect(ui.totalCount).toBe(50);
  });
});

describe('live header progress push', () => {
  it('pushes relevance phase + totals into the store on enqueue', async () => {
    await enqueueCandidates(ids(50)); // 2 batches submitted, 50 candidates
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('relevance', 0, 50);
  });

  it('resets the header to idle once the run finalizes', async () => {
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.1]]), // sub-threshold → no reasons, finalize
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    expect(currentRun()).toBeNull(); // finalized + cleared
    expect(mockSetAsyncJobPhase.mock.calls.at(-1)).toEqual(['idle']);
  });
});

// ---------------------------------------------------------------------------
// Finalize side-effects (Round-4 B): stamp markProcessingRunFinished + the
// post-finalize kick that starts the next run when a full quantum still waits.
// ---------------------------------------------------------------------------

describe('finalize side-effects', () => {
  async function finalizeSingleBatchRun() {
    await enqueueCandidates(['a0']); // escape default → 1 batch
    const batch = currentRun().batches[0];
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.1]]), // sub-threshold → no reasons → finalize
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    await handlePush(batch.requestId, 'foreground');
  }

  it('stamps markProcessingRunFinished when a cloud run finalizes', async () => {
    await finalizeSingleBatchRun();
    expect(currentRun()).toBeNull();
    expect(mockMarkProcessingRunFinished).toHaveBeenCalled();
  });

  it('post-finalize kick starts the next run when ≥25 unscored still remain', async () => {
    await finalizeSingleBatchRun();
    expect(currentRun()).toBeNull();

    // A full quantum of unscored rows is available for the kick to pick up.
    mockGetUnscored.mockResolvedValue(
      ids(25, 'kick').map((id) => candidate(id)),
    );

    // Fire the scheduled setTimeout(0) kick + flush its async body.
    await jest.advanceTimersByTimeAsync(0);

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(25);
  });

  it('post-finalize kick does nothing when no unscored rows remain', async () => {
    await finalizeSingleBatchRun();
    // mockGetUnscored returns [] while no run exists (default impl) → kick no-ops.
    await jest.advanceTimersByTimeAsync(0);
    expect(currentRun()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-3 B1 — advisory judge (persist math at submit, notes-only decode,
// calibration capture) + per-fact stage projection.
// ---------------------------------------------------------------------------

/** Make computeMathStage return an all-math-mode batch with the given scores. */
function mockMathMode(scores: Record<string, number>) {
  mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
    persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
    stage: candidates.map((c) => ({ input: { id: c.id } })),
    computedScoreMap: new Map(Object.entries(scores)),
    componentsMap: new Map(candidates.map((c) => [c.id, { geoAlignment: 'NONE' }])),
    modeMap: new Map(candidates.map((c) => [c.id, 'math'])),
  }));
}

describe('judge mode (advisory)', () => {
  beforeEach(() => {
    mockBuildJudgeCalls.mockReturnValue({
      calls: [{ id: 'judge:0', system: 's', prompt: 'p' }],
      chunkIds: new Map(),
    });
    mockDecodeJudgeResults.mockReturnValue({
      rawScoreMap: new Map(),
      judgeScoreMap: new Map(),
      reasonMap: new Map(),
      overrideMap: new Map(),
      adjustedIds: new Set(),
    });
  });

  it('persists the math at submit (bucketed relevance + reasonSkipped) and only judges above-threshold rows', async () => {
    mockMathMode({ a0: 0.8, a1: 0.2 });
    await enqueueCandidates(['a0', 'a1']);

    // math persisted immediately for BOTH rows, reason:''
    expect(mockBatchSaveMathScores).toHaveBeenCalledTimes(1);
    const saved = mockBatchSaveMathScores.mock.calls[0][0] as any[];
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a0', relevance: 0.8, reasonSkipped: false }),
        expect.objectContaining({ id: 'a1', relevance: 0.2, reasonSkipped: true }),
      ]),
    );
    // judge job built over the above-threshold subset only (a0)
    const judgeStage = mockBuildJudgeCalls.mock.calls[0][0] as any[];
    expect(judgeStage.map((c) => c.input.id)).toEqual(['a0']);

    const batch = currentRun().batches[0];
    expect(batch.phase).toBe('waiting-relevance');
    expect(batch.judgeMode).toBe(true);
    expect(batch.judgedIds).toEqual(['a0']);
  });

  it('marks the batch done at submit without a judge job when nothing is above threshold', async () => {
    mockMathMode({ a0: 0.1, a1: 0.2 });
    mockSendInferenceRequest.mockClear();
    await enqueueCandidates(['a0', 'a1']);

    expect(mockBatchSaveMathScores).toHaveBeenCalledTimes(1);
    expect(mockBuildJudgeCalls).not.toHaveBeenCalled();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    // single batch, no cloud job → finalized + cleared
    expect(currentRun()).toBeNull();
  });

  it('decode applies notes (advisory) and records calibration overrides — never rescores', async () => {
    mockMathMode({ a0: 0.8 });
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];

    mockDecodeJudgeResults.mockReturnValue({
      rawScoreMap: new Map([['a0', 0.8]]), // == computed (advisory)
      judgeScoreMap: new Map([['a0', 0.3]]),
      reasonMap: new Map([['a0', 'why it matters']]),
      overrideMap: new Map([['a0', true]]),
      adjustedIds: new Set(),
    });
    mockGetComputedComponentsByIds.mockResolvedValue(
      new Map([['a0', { computedScore: 0.8, components: { geoAlignment: 'NONE' } }]]),
    );
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'judge:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    // note applied via saveReason; relevance NEVER re-persisted at decode
    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'why it matters');
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
    // calibration case built + recorded for the overridden row
    expect(mockBuildCalibrationCase).toHaveBeenCalledWith('a0', 0.8, 0.3, { geoAlignment: 'NONE' });
    expect(mockRecordOverrides).toHaveBeenCalledTimes(1);
    // single batch → finalized
    expect(currentRun()).toBeNull();
  });
});

describe('derivePipelineBatchProgress', () => {
  it('projects {done, total} article counts (done = relevance-known articles)', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'done', candidateIds: ['a', 'b'] },
          { phase: 'waiting-relevance', candidateIds: ['c'] },
        ]),
      ),
    ).toEqual({ done: 2, total: 3 });
  });

  it('counts relevance-known non-terminal batches toward done', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'waiting-reasons', candidateIds: ['a', 'b'] },
          { phase: 'waiting-relevance', candidateIds: ['c'] },
        ]),
      ),
    ).toEqual({ done: 2, total: 3 });
  });

  it('is {done:0,total:0} when every batch is terminal (idle)', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([{ phase: 'done', candidateIds: ['a'] }]),
      ),
    ).toEqual({ done: 0, total: 0 });
  });

  it('projects a legacy per-fact run identically (batches just counted)', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'done', factId: 'f1', factStatement: 'Fact one', candidateIds: ['a'] },
          { phase: 'waiting-relevance', factId: 'f2', factStatement: 'Fact two', candidateIds: ['b', 'c'] },
        ]),
      ),
    ).toEqual({ done: 1, total: 3 });
  });
});
