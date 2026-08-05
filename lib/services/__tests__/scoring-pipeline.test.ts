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
const mockGetScoredDonorRows = jest.fn();
const mockGetScoredWithoutReasons = jest.fn();
const mockSaveScoringResult = jest.fn();
const mockSaveReason = jest.fn();
const mockBatchMarkReasonSkipped = jest.fn();
// Terminal `excluded` write — hard "not interested" filters AND the top-headline
// cull both land here.
const mockBatchMarkExcluded = jest.fn();
const mockBatchSaveMathScores = jest.fn();
const mockGetComputedComponentsByIds = jest.fn((..._args: any[]) => Promise.resolve(new Map()));
// P4b: stage-row lookup behind the headline/standard enqueue partition.
const mockGetStageRowsByIds = jest.fn((..._args: any[]) => Promise.resolve([] as any[]));
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
// The effective (store + calibration aware) harness config. `undefined` is the
// pre-existing shape these tests exercised — before this export was mocked at
// all, `judgeHarnessConfig` fail-opened to DEFAULT_HARNESS_CONFIG, and
// `?? DEFAULT_HARNESS_CONFIG` keeps that identical. The RELEVANCE_V2 cases
// override it per-test.
const mockEffectiveHarnessConfig = jest.fn();
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
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

jest.mock('@/lib/llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));

jest.mock('@/lib/llm/gateway-rate-limiter', () => ({
  // Must mirror the real module's constant: scoring-pipeline derives its poll
  // cadence from it at import time, so omitting it makes POLL_INTERVAL_MS NaN
  // and silently disables the per-batch spacing gate.
  MIN_GATEWAY_INTERVAL_MS: 3000,
  tryTakeImmediate: (...args: any[]) => mockTryTakeImmediate(...args),
  pauseFor: (...args: any[]) => mockPauseFor(...args),
  acquire: (...args: any[]) => mockAcquire(...args),
}));

jest.mock('@/lib/llm/submitInferenceJob', () => ({
  sendInferenceRequest: (...args: any[]) => mockSendInferenceRequest(...args),
  bytesToHex: (...args: any[]) => mockBytesToHex(...args),
}));

jest.mock('@/lib/e2ee/e2ee-service', () => {
  // Faithful stand-in so `err instanceof ModelKeyValidationError` works in the
  // pipeline's submit-site catches.
  class ModelKeyValidationError extends Error {
    keyHex: string;
    algo: string;
    model: string;
    endpoint: string;
    constructor(message: string, details: any = {}) {
      super(message);
      this.name = 'ModelKeyValidationError';
      this.keyHex = details.keyHex ?? '';
      this.algo = details.algo ?? 'ecdsa';
      this.model = details.model ?? '';
      this.endpoint = details.endpoint ?? '';
      Object.setPrototypeOf(this, ModelKeyValidationError.prototype);
    }
  }
  return {
    ModelKeyValidationError,
    prepareE2EEContext: (...args: any[]) => mockPrepareE2EEContext(...args),
    rebuildE2EEContext: (...args: any[]) => mockRebuildE2EEContext(...args),
  };
});

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscored(...args),
  countUnscoredSuggestions: (...args: any[]) => mockCountUnscoredSuggestions(...args),
  getOldestUnscoredCreatedAt: (...args: any[]) => mockGetOldestUnscoredCreatedAt(...args),
  getScoredDonorRows: (...args: any[]) => mockGetScoredDonorRows(...args),
  getScoredSuggestionsWithoutReasons: (...args: any[]) => mockGetScoredWithoutReasons(...args),
  saveScoringResult: (...args: any[]) => mockSaveScoringResult(...args),
  saveReason: (...args: any[]) => mockSaveReason(...args),
  batchMarkReasonSkipped: (...args: any[]) => mockBatchMarkReasonSkipped(...args),
  batchMarkExcluded: (...args: any[]) => mockBatchMarkExcluded(...args),
  batchSaveMathScores: (...args: any[]) => mockBatchSaveMathScores(...args),
  getComputedComponentsByIds: (...args: any[]) => mockGetComputedComponentsByIds(...args),
  getStageRowsByIds: (...args: any[]) => mockGetStageRowsByIds(...args),
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
  effectiveHarnessConfig: (...args: any[]) => mockEffectiveHarnessConfig(...args),
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
  enqueueUnscoredEligible,
  enqueueOrphanedReasons,
  handlePush,
  pollTick,
  recover,
  abortRun,
  getPipelineStatus,
  derivePipelineUiState,
  getPipelineUiState,
  derivePipelineBatchProgress,
  isFeedCold,
  _resetForTests,
  BATCH_SIZE,
  MAX_UNSCORED_WAIT_MS,
  MIN_DISPATCH,
  MAX_BATCH_ARTICLES,
  MIN_DISPATCH_HEADLINE,
  MAX_BATCH_ARTICLES_HEADLINE,
} from '@/lib/services/scoring-pipeline';
import type { PipelineRun } from '@/lib/database/services/scoring-pipeline-store';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { ModelKeyValidationError } from '@/lib/e2ee/e2ee-service';
import logger from '@/lib/logger';

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
  // Default WARM: a scored donor exists in the 48h window, so isFeedCold() is
  // false and every existing test keeps the warm enqueue/poll behavior. The
  // P7d cold-start tests override this to [] to exercise the cold path.
  mockGetScoredDonorRows.mockResolvedValue([{ id: 'donor-warm' }]);
  mockGetScoredWithoutReasons.mockResolvedValue([]);
  mockSaveScoringResult.mockResolvedValue(undefined);
  mockSaveReason.mockResolvedValue(undefined);
  mockBatchMarkReasonSkipped.mockResolvedValue(undefined);
  mockBatchMarkExcluded.mockResolvedValue(undefined);
  mockBucketScores.mockImplementation(() => undefined); // no-op: raw == bucketed
  mockEffectiveHarnessConfig.mockResolvedValue(undefined); // → DEFAULT (v2 off)
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
  // P4b default: no headline rows ⇒ one standard partition ⇒ the pre-P4b batch
  // layout every other test in this file asserts.
  mockGetStageRowsByIds.mockResolvedValue([]);
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

// P8 site 1b — `enqueueUnscoredEligible` is the enqueue that fires when
// feed-sync hydrated NOTHING (runPostFinalizeKick on a quiet feed, and the
// suppressed cycle). Its predicate is separate from the feed-sync tombstone's,
// so leaving the fact requirement here would have enqueued headlines ONLY on
// syncs that happened to hydrate new articles — intermittent, and unfalsifiable
// in QA.
describe('enqueueUnscoredEligible — headline admission (P8 site 1b)', () => {
  const headlineRow = (id: string) => ({
    id,
    titleEn: 'title',
    descriptionEn: 'desc',
    countryCode: null,
    userTopicIds: [],
    relatedFacts: [], // factless BY DESIGN — synthetic matched topic, topicId null
    meta: { headlineScope: 'GLOBAL' },
  });

  it('enqueues a factless TOP-HEADLINE row', async () => {
    mockGetUnscored.mockResolvedValue([headlineRow('h1')]);

    const res = await enqueueUnscoredEligible();

    expect(res.enqueued).toBe(1);
  });

  it('still skips a factless row that is NOT headline-sourced', async () => {
    mockGetUnscored.mockResolvedValue([
      { ...headlineRow('orphan'), meta: { headlineScope: null } },
    ]);

    const res = await enqueueUnscoredEligible();

    expect(res.enqueued).toBe(0);
  });

  it('still skips a headline row with no English text', async () => {
    mockGetUnscored.mockResolvedValue([{ ...headlineRow('h-empty'), descriptionEn: null }]);

    const res = await enqueueUnscoredEligible();

    expect(res.enqueued).toBe(0);
  });
});

describe('model-key validation fail-fast (MERA-APP-39)', () => {
  it('fails a relevance batch terminally when the E2EE rebuild rejects with ModelKeyValidationError — no submit, no loop', async () => {
    mockRebuildE2EEContext.mockRejectedValue(
      new ModelKeyValidationError('bad point: is not on curve', {
        keyHex: 'deadbeef',
        algo: 'ecdsa',
        model: 'test-small-model',
        endpoint: 'https://inference.test/api/attestation/report',
      }),
    );

    await enqueueCandidates(ids(25)); // 1 batch

    // The bad key is rejected BEFORE any gateway POST.
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    // The run finalized (batch went terminal) instead of re-driving forever.
    expect(mockMarkProcessingRunFinished).toHaveBeenCalled();
    expect(await getPipelineStatus()).toBe('idle');
  });

  it('does not re-drive a poll tick after a model-key failure (loop is dead)', async () => {
    mockRebuildE2EEContext.mockRejectedValue(
      new ModelKeyValidationError('bad point: is not on curve', {
        keyHex: 'deadbeef',
        algo: 'ecdsa',
        model: 'test-small-model',
        endpoint: 'https://inference.test/api/attestation/report',
      }),
    );

    await enqueueCandidates(ids(25));
    mockRebuildE2EEContext.mockClear();
    mockSendInferenceRequest.mockClear();

    // A subsequent tick finds no run and does nothing — the ~7s re-drive is gone.
    await pollTick('foreground');

    expect(mockRebuildE2EEContext).not.toHaveBeenCalled();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('contains a generic rebuild throw instead of letting it escape the drain', async () => {
    // Previously this propagated out of doDrain → drain() → runPollerTick,
    // leaving the batch stranded in submitting-* while revertStuckSubmitters
    // requeued it every 60s — the MERA-APP-39 wedge, which made every
    // feed-sync cycle a no-op for as long as the run stayed non-terminal.
    // Now the throw is captured, the batch goes through failOrRetrySubmit, and
    // the drain resolves normally.
    mockRebuildE2EEContext.mockRejectedValue(new Error('some other failure'));

    await expect(enqueueCandidates(ids(25))).resolves.toBeDefined();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'some other failure' }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: 'submit' }),
      }),
    );
  });

  it('caps submit retries so a persistently-throwing batch cannot loop forever', async () => {
    // revertStuckSubmitters used to requeue without checking MAX_BATCH_ATTEMPTS,
    // so a submit that throws every time cycled indefinitely and only the
    // FeedSyncMachine stale guard broke it. The batch must reach a terminal
    // phase and let the run finalize.
    mockRebuildE2EEContext.mockRejectedValue(new Error('always fails'));

    await enqueueCandidates(ids(25));
    // Drive further ticks; the batch must not come back around forever.
    await pollTick('foreground');
    await pollTick('foreground');

    expect(await getPipelineStatus()).toBe('idle');
    expect(mockMarkProcessingRunFinished).toHaveBeenCalled();
  });
});

describe('enqueueCandidates', () => {
  it('creates a run and submits up to MAX_IN_FLIGHT batches', async () => {
    await enqueueCandidates(ids(4 * MAX_BATCH_ARTICLES)); // 4 batches of 25

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
    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // 2 batches
    const before = currentRun().batches.length;
    mockSendInferenceRequest.mockClear();

    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // identical ids

    expect(currentRun().batches.length).toBe(before);
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('attaches the push token only to the last relevance submit', async () => {
    // 2 batches, both admitted (MAX_IN_FLIGHT >= 2).
    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES));

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

    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // 2 batches

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

// The gate elects ONE representative per duplicate story group and holds the
// siblings back to inherit its score, so `candidateIds` is a fraction of the
// articles a run analyses. Each batch records the articles it covers, which is
// what the "Analysing X of Y articles" header counts.
describe('enqueueCandidates — covered-id bookkeeping', () => {
  it('records the gate coverage on the batch and leaves dispatch untouched', async () => {
    await enqueueCandidates(['rep', 'solo', 'x1', 'x2', 'x3'], false, {
      rep: ['rep', 'sib1', 'sib2'],
      solo: ['solo'],
    });

    const batch = currentRun().batches[0];
    expect(batch.candidateIds).toEqual(['rep', 'solo', 'x1', 'x2', 'x3']);
    // Ids without a gate entry cover themselves.
    expect(batch.coveredIds).toEqual([
      'rep', 'sib1', 'sib2', 'solo', 'x1', 'x2', 'x3',
    ]);
    expect(derivePipelineBatchProgress(currentRun()).total).toBe(7);
  });

  it('writes coveredIds even with no gate map, so the denominator survives the submit shrink', async () => {
    await enqueueCandidates(ids(MIN_DISPATCH));
    const batch = currentRun().batches[0];
    expect(batch.coveredIds).toEqual(batch.candidateIds);
  });
});

describe('enqueueCandidates: MIN_DISPATCH floor / MAX_BATCH_ARTICLES ceiling', () => {
  it('dispatches at exactly MIN_DISPATCH — one LLM call, no waiting for a bigger batch', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh — no escape needed

    const res = await enqueueCandidates(ids(MIN_DISPATCH));

    // The whole point of the floor: 5 ready articles go out NOW rather than
    // waiting out MAX_UNSCORED_WAIT_MS for a quantum that may never fill.
    expect(res.deferred).toHaveLength(0);
    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('defers a sub-MIN_DISPATCH remainder when the oldest unscored row is fresh', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // age 0 — no escape

    const res = await enqueueCandidates(ids(MIN_DISPATCH - 1));

    expect(res.deferred).toHaveLength(MIN_DISPATCH - 1);
    expect(currentRun()).toBeNull();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('flushPartial=true dispatches a sub-MIN_DISPATCH remainder and returns no deferred ids', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh — would normally defer

    const res = await enqueueCandidates(ids(2), true);

    expect(res.deferred).toHaveLength(0);
    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(2);
  });

  it('lets ONE batch absorb everything ready rather than splitting into MIN_DISPATCH pieces', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);

    // 40 ready → a single batch (8 LLM calls inside one request), NOT 8 batches.
    await enqueueCandidates(ids(40));

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(40);
  });

  it('caps a batch at MAX_BATCH_ARTICLES and spills the rest into further batches', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);

    // One full ceiling batch + a second holding the overflow (still >= the floor).
    await enqueueCandidates(ids(MAX_BATCH_ARTICLES + MIN_DISPATCH));

    const run = currentRun();
    expect(run.batches).toHaveLength(2);
    expect(run.batches[0].candidateIds).toHaveLength(MAX_BATCH_ARTICLES);
    expect(run.batches[1].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('dispatches a sub-MIN_DISPATCH remainder once the oldest row exceeds MAX_UNSCORED_WAIT_MS (escape)', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW - MAX_UNSCORED_WAIT_MS - 1_000);

    await enqueueCandidates(ids(3));

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(3);
  });

  it('applies the SAME rule to appends: ceiling+remainder with an active run', async () => {
    // Establish an active run.
    await enqueueCandidates(ids(MIN_DISPATCH, 'seed'));
    const before = currentRun().batches.length;
    expect(before).toBe(1);

    // Fresh oldest → a sub-floor remainder must still defer on an append.
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);

    const res = await enqueueCandidates(
      ids(MAX_BATCH_ARTICLES + MIN_DISPATCH - 1, 'more'),
    );

    const run = currentRun();
    expect(run.batches).toHaveLength(before + 1);
    expect(run.batches[run.batches.length - 1].candidateIds).toHaveLength(
      MAX_BATCH_ARTICLES,
    );
    expect(res.deferred).toHaveLength(MIN_DISPATCH - 1);
  });

  it('enqueueOrphanedReasons is ungated by the dispatch floor', async () => {
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

describe('cold-start predicate (P7d isFeedCold)', () => {
  it('reports cold while no scored donor exists in the 48h window', async () => {
    mockGetScoredDonorRows.mockResolvedValue([]);
    expect(await isFeedCold()).toBe(true);
  });

  it('reports warm as soon as a scored donor exists', async () => {
    mockGetScoredDonorRows.mockResolvedValue([{ id: 'donor' }]);
    expect(await isFeedCold()).toBe(false);
  });

  it('caches the warm verdict per process and re-reads only after _resetForTests', async () => {
    // Warm: a donor exists → false, and the verdict is cached permanently.
    mockGetScoredDonorRows.mockResolvedValue([{ id: 'donor' }]);
    expect(await isFeedCold()).toBe(false);

    // Donors vanish, but the cached warm verdict survives (warm is permanent per
    // process) — no re-query flips it back to cold.
    mockGetScoredDonorRows.mockResolvedValue([]);
    expect(await isFeedCold()).toBe(false);

    // _resetForTests clears the module cache → the next read reflects the DB.
    _resetForTests();
    expect(await isFeedCold()).toBe(true);
  });

  it('fails WARM on a donor read error (never triggers the cold knobs off a failed read)', async () => {
    mockGetScoredDonorRows.mockRejectedValue(new Error('db read failed'));
    expect(await isFeedCold()).toBe(false);
  });
});

// The P7d "Knob 1" cold-start partial (dispatch a >=10-row partial only on a
// cold feed) is gone: MIN_DISPATCH is 5, so every chunk that knob would have
// caught now dispatches on the fast path regardless of feed warmth. These tests
// pin the replacement invariant — warmth no longer affects dispatch at all.
describe('dispatch floor is warmth-independent (replaces P7d Knob 1)', () => {
  it('dispatches a >= MIN_DISPATCH batch on a COLD feed with no staleness escape', async () => {
    mockGetScoredDonorRows.mockResolvedValue([]); // cold: no scored donors
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh → no escape

    await enqueueCandidates(ids(MIN_DISPATCH));

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('dispatches the SAME batch on a WARM feed — warmth is no longer consulted', async () => {
    mockGetScoredDonorRows.mockResolvedValue([{ id: 'donor' }]); // warm
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh → no escape

    await enqueueCandidates(ids(MIN_DISPATCH));

    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('defers below the floor on a cold feed too (fresh oldest, no escape)', async () => {
    mockGetScoredDonorRows.mockResolvedValue([]); // cold
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh → no escape

    await enqueueCandidates(ids(MIN_DISPATCH - 1));

    expect(currentRun()).toBeNull();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });
});

describe('cold-start poll latency (P7d Knob 2)', () => {
  // Default stale oldest → the single-id partial dispatches via the staleness
  // escape, giving us one waiting-relevance batch to poll.
  async function oneWaitingBatch() {
    await enqueueCandidates(['a0']);
    const b = currentRun().batches[0];
    expect(b.phase).toBe('waiting-relevance');
    return b;
  }

  // MIN_POLL_AGE_MS is now 0 for every feed — the old 15s settling delay put a
  // hard floor under the first scored paint even when the job was already done,
  // and the gateway rate limiter (not this gate) is what stops us hammering. So
  // the cold/warm split these tests pinned no longer exists; both poll at once.
  it('polls a freshly-submitted batch immediately on a COLD feed (no settling delay)', async () => {
    mockGetScoredDonorRows.mockResolvedValue([]); // cold
    await oneWaitingBatch();
    mockFetchResults.mockClear();
    mockFetchResults.mockResolvedValue('pending');

    await pollTick('foreground');

    expect(mockFetchResults).toHaveBeenCalled();
  });

  it('polls a freshly-submitted batch immediately on a WARM feed too', async () => {
    mockGetScoredDonorRows.mockResolvedValue([{ id: 'donor' }]); // warm
    await oneWaitingBatch();
    mockFetchResults.mockClear();
    mockFetchResults.mockResolvedValue('pending');

    await pollTick('foreground');

    expect(mockFetchResults).toHaveBeenCalled();
  });

  it('honours PER_BATCH_POLL_SPACING_MS between two polls of the SAME batch', async () => {
    mockGetScoredDonorRows.mockResolvedValue([{ id: 'donor' }]);
    await oneWaitingBatch();
    mockFetchResults.mockResolvedValue('pending');

    // Step past the gateway slot the SUBMIT just consumed, so this first poll
    // is gated only by the per-batch spacing we're actually testing.
    jest.setSystemTime(NOW + 5_000);
    await pollTick('foreground');
    expect(mockFetchResults).toHaveBeenCalled();
    mockFetchResults.mockClear();

    // Immediately again — inside the spacing window, so skipped.
    await pollTick('foreground');
    expect(mockFetchResults).not.toHaveBeenCalled();

    // Past the window (and past the limiter's own interval) — polled again.
    jest.setSystemTime(NOW + 15_000);
    await pollTick('foreground');
    expect(mockFetchResults).toHaveBeenCalled();
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
    await enqueueCandidates(ids(4 * MAX_BATCH_ARTICLES)); // 4 batches: 3 waiting, 1 queued
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

// ---------------------------------------------------------------------------
// P8 — SOFT suppression ("Shown less") on the BACKSTOP/legacy path.
//
// The cloud LLM knows nothing about the user's filters and its score REPLACES
// the math score that carried the penalty, so a soft filter used to be computed
// and then discarded on this path — which, with enrichment unshipped, is every
// article. Submit carries the already-computed penalty on the batch; decode
// subtracts it before bucketing, the reason gate and discardLowRelevance.
// ---------------------------------------------------------------------------

/** Backstop batch whose componentsMap carries the given suppression penalties. */
function mockBackstopWithPenalties(penalties: Record<string, number>) {
  mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
    persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
    stage: candidates.map((c) => ({ input: { id: c.id } })),
    computedScoreMap: new Map(),
    componentsMap: new Map(
      candidates.map((c) => [c.id, { geoAlignment: 'NONE', suppressPenalty: penalties[c.id] ?? 0 }]),
    ),
    modeMap: new Map(candidates.map((c) => [c.id, 'backstop'])),
  }));
}

describe('soft suppression on the legacy path', () => {
  // jest.clearAllMocks() clears CALLS, not implementations — restore the
  // module-level default so these overrides never leak into later suites.
  afterEach(() => {
    mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
      persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
      stage: candidates.map((c) => ({ input: { id: c.id } })),
      computedScoreMap: new Map(),
      componentsMap: new Map(),
      modeMap: new Map(candidates.map((c) => [c.id, 'backstop'])),
    }));
    mockBuildJudgeCalls.mockReset();
  });

  it('carries only the NON-ZERO penalties on the batch at submit', async () => {
    mockBackstopWithPenalties({ a0: 0.3, a1: 0 });
    await enqueueCandidates(['a0', 'a1']);

    const batch = currentRun().batches[0];
    expect(batch.phase).toBe('waiting-relevance');
    expect(batch.suppressPenaltyMap).toEqual({ a0: 0.3 });
  });

  it('omits the field entirely when nothing matched (pre-change code path)', async () => {
    mockBackstopWithPenalties({ a0: 0, a1: 0 });
    await enqueueCandidates(['a0', 'a1']);

    expect(currentRun().batches[0].suppressPenaltyMap).toBeUndefined();
  });

  it('subtracts the penalty from the persisted LLM score, leaving unmatched rows byte-identical', async () => {
    mockBackstopWithPenalties({ a0: 0.3, a1: 0 });
    await enqueueCandidates(['a0', 'a1']);
    const batch = currentRun().batches[0];

    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.8], ['a1', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([]);
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    const saved = Object.fromEntries(
      mockSaveScoringResult.mock.calls.map((c: any[]) => [c[0], c[1].relevance]),
    );
    expect(saved.a0).toBeCloseTo(0.5, 10);
    expect(saved.a1).toBe(0.8); // strict: matched nothing ⇒ untouched
  });

  it('never drives the persisted score below 0', async () => {
    mockBackstopWithPenalties({ a0: 0.6 });
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];

    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.1]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    expect(mockSaveScoringResult).toHaveBeenCalledWith('a0', expect.objectContaining({ relevance: 0 }));
  });

  it('demotes below the reason gate — a penalised row earns no reasons job', async () => {
    mockBackstopWithPenalties({ a0: 0.3 });
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];

    // 0.5 clears REASON_RELEVANCE_THRESHOLD (0.3); 0.5 − 0.3 = 0.2 does not.
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.5]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    mockSendInferenceRequest.mockClear();

    await handlePush(batch.requestId, 'foreground');

    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    expect(mockDiscardLowRelevance).toHaveBeenCalled();
  });

  it('penalises the MATH-mode rows of a MIXED batch too (they ride the legacy prompt)', async () => {
    // One backstop row forces the whole batch down the legacy path, which
    // submits `active` — every survivor, math-mode ones included. Keying the
    // penalty map over `math.stage` (not just the backstop rows) is what stops
    // those math rows from silently losing their penalty. This is the
    // regression contract for that decision.
    mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
      persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
      stage: candidates.map((c) => ({ input: { id: c.id } })),
      computedScoreMap: new Map(candidates.map((c) => [c.id, 0.7])),
      componentsMap: new Map(
        candidates.map((c) => [c.id, { geoAlignment: 'NONE', suppressPenalty: 0.3 }]),
      ),
      modeMap: new Map(candidates.map((c) => [c.id, c.id === 'a1' ? 'backstop' : 'math'])),
    }));
    await enqueueCandidates(['a0', 'a1']);

    const batch = currentRun().batches[0];
    expect(batch.judgeMode).toBeFalsy(); // legacy path (a1 is backstop)
    expect(batch.suppressPenaltyMap).toEqual({ a0: 0.3, a1: 0.3 });

    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.8], ['a1', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([]);
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    const saved = Object.fromEntries(
      mockSaveScoringResult.mock.calls.map((c: any[]) => [c[0], c[1].relevance]),
    );
    expect(saved.a0).toBeCloseTo(0.5, 10);
    expect(saved.a1).toBeCloseTo(0.5, 10);
  });

  it('never carries a penalty map on a judge-mode batch (the math score already has it)', async () => {
    mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
      persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
      stage: candidates.map((c) => ({ input: { id: c.id } })),
      computedScoreMap: new Map([['a0', 0.8]]),
      componentsMap: new Map(
        candidates.map((c) => [c.id, { geoAlignment: 'NONE', suppressPenalty: 0.3 }]),
      ),
      modeMap: new Map(candidates.map((c) => [c.id, 'math'])),
    }));
    mockBuildJudgeCalls.mockReturnValue({
      calls: [{ id: 'judge:0', system: 's', prompt: 'p' }],
      chunkIds: new Map(),
    });
    await enqueueCandidates(['a0']);

    const batch = currentRun().batches[0];
    expect(batch.judgeMode).toBe(true);
    expect(batch.suppressPenaltyMap).toBeUndefined();
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
    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // 2 waiting-relevance (non-terminal) batches
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
    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // 2 batches, both waiting
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
    await enqueueCandidates(ids(MIN_DISPATCH));
    const target = currentRun().batches[0];
    mockFetchResults.mockClear();
    mockFetchResults.mockResolvedValue('pending');

    await handlePush('nonexistent-req', 'foreground');

    // The unknown id can't target a batch, so it degrades to a full pollTick —
    // which now polls the waiting batch straight away (MIN_POLL_AGE_MS is 0).
    // This previously asserted "nothing polled", but that was only ever a
    // side-effect of the old 15s settling delay, not the fallback's behaviour.
    expect(mockFetchResults).toHaveBeenCalledWith(
      target.requestId,
      'foreground',
      expect.anything(),
    );
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
    await enqueueCandidates(ids(4 * MAX_BATCH_ARTICLES)); // 4 batches: 3 waiting-relevance, 1 queued
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

    // Foreground tick picks it up. Pin the remaining batches to 'pending' first:
    // MIN_POLL_AGE_MS is now 0, so a foreground tick polls EVERY waiting batch
    // immediately — left on b0's completed payload they'd all complete and the
    // run would finalize and clear, which is not what this test is about.
    mockFetchResults.mockResolvedValue('pending');
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
    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // 2 batches, both waiting-relevance
    const ui = await getPipelineUiState();
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(0);
    expect(ui.totalCount).toBe(2 * MAX_BATCH_ARTICLES);
  });
});

describe('live header progress push', () => {
  it('pushes relevance phase + totals into the store on enqueue', async () => {
    await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)); // 2 batches submitted, 50 candidates
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('relevance', 0, 2 * MAX_BATCH_ARTICLES);
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

    // RELEVANCE_V2 OFF (the default) → the bucketing still runs. This is the
    // "nothing changed" half of the flag.
    expect(mockBucketScores).toHaveBeenCalled();
  });

  // RELEVANCE_V2 changes exactly one thing on this path: the value persisted as
  // `relevance`. `bucketScores` is a no-op in these orchestrator tests (raw ==
  // bucketed), so the routing decision is pinned by whether it is CALLED.
  it('RELEVANCE_V2 ON: persists the UNBUCKETED computed score and never buckets', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue({
      ...DEFAULT_HARNESS_CONFIG,
      scoringEngine: {
        ...DEFAULT_HARNESS_CONFIG.scoringEngine,
        USE_ARTICLE_TAGS: true,
        RELEVANCE_V2: true,
      },
    });
    // 0.83 would have bucketed to 0.8; 0.44 to 0.4. 0.2 is under discardFloor,
    // so bucketing never touched it either way.
    mockMathMode({ a0: 0.83, a1: 0.44, a2: 0.2 });
    await enqueueCandidates(['a0', 'a1', 'a2']);

    expect(mockBucketScores).not.toHaveBeenCalled();
    const saved = mockBatchSaveMathScores.mock.calls[0][0] as any[];
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a0', relevance: 0.83, reasonSkipped: false }),
        expect.objectContaining({ id: 'a1', relevance: 0.44, reasonSkipped: false }),
        expect.objectContaining({ id: 'a2', relevance: 0.2, reasonSkipped: true }),
      ]),
    );
    // rawScore / computedScore are the SAME raw value as before — untouched.
    expect(saved.find((s) => s.id === 'a0')).toMatchObject({
      rawScore: 0.83,
      computedScore: 0.83,
    });
    // Threshold membership is unchanged by the flag: bucketing never moves a
    // value across REASON_RELEVANCE_THRESHOLD (0.3), so the judged subset is
    // exactly the same one the bucketed path would have produced.
    const judgeStage = mockBuildJudgeCalls.mock.calls[0][0] as any[];
    expect(judgeStage.map((c) => c.input.id)).toEqual(['a0', 'a1']);
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

// ---------------------------------------------------------------------------
// Top-headline cull — a headline-sourced row scoring below the MEDIUM band
// (relevanceBandRank >= 3, i.e. < 0.53) is terminally `excluded` instead of
// persisted. Topic-matched rows are never culled. Both scoring paths.
// ---------------------------------------------------------------------------

/** mockMathMode + a headline scope on the stage input of `headlineIds` — the
 *  field the judge-path cull reads (c.input.headlineScope). */
function mockMathModeWithHeadlines(
  scores: Record<string, number>,
  headlineIds: string[],
) {
  const headline = new Set(headlineIds);
  mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
    persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
    stage: candidates.map((c) => ({
      input: {
        id: c.id,
        headlineScope: headline.has(c.id) ? 'GLOBAL' : null,
      },
    })),
    computedScoreMap: new Map(Object.entries(scores)),
    componentsMap: new Map(candidates.map((c) => [c.id, { geoAlignment: 'NONE' }])),
    modeMap: new Map(candidates.map((c) => [c.id, 'math'])),
  }));
}

describe('top-headline cull — judge path', () => {
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

  it('excludes a LOW headline and keeps it out of the math persist, the judge job and the discard map', async () => {
    // h0 = headline at 0.4 (band rank 3 → culled). t0 = topic-matched survivor,
    // so a judge job is still built and the run reaches waiting-relevance.
    mockMathModeWithHeadlines({ h0: 0.4, t0: 0.8 }, ['h0']);
    await enqueueCandidates(['h0', 't0']);

    expect(mockBatchMarkExcluded).toHaveBeenCalledWith(['h0']);

    // A math score persisted after the exclusion would overwrite the terminal
    // status — h0 must not be in the payload at all.
    const saved = mockBatchSaveMathScores.mock.calls[0][0] as any[];
    expect(saved.map((s) => s.id)).toEqual(['t0']);

    // 0.4 clears the raw `> 0.3` judged filter, so the cull is what keeps it out.
    const judgeStage = mockBuildJudgeCalls.mock.calls[0][0] as any[];
    expect(judgeStage.map((c) => c.input.id)).toEqual(['t0']);

    const batch = currentRun().batches[0];
    expect(batch.judgedIds).toEqual(['t0']);
    // relevanceMap drives discardLowRelevance at decode; a culled id present
    // here would be flipped back from `excluded` to reason-skipped `complete`.
    expect(batch.relevanceMap).toEqual({ t0: 0.8 });
  });

  it('leaves a MEDIUM headline alone (persisted + judged as normal)', async () => {
    mockMathModeWithHeadlines({ h0: 0.6 }, ['h0']);
    await enqueueCandidates(['h0']);

    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
    const saved = mockBatchSaveMathScores.mock.calls[0][0] as any[];
    expect(saved).toEqual([
      expect.objectContaining({ id: 'h0', relevance: 0.6, reasonSkipped: false }),
    ]);
    const judgeStage = mockBuildJudgeCalls.mock.calls[0][0] as any[];
    expect(judgeStage.map((c) => c.input.id)).toEqual(['h0']);
    expect(currentRun().batches[0].relevanceMap).toEqual({ h0: 0.6 });
  });

  it('never culls a topic-matched row at the same LOW score', async () => {
    mockMathModeWithHeadlines({ t0: 0.4 }, []);
    await enqueueCandidates(['t0']);

    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
    const saved = mockBatchSaveMathScores.mock.calls[0][0] as any[];
    expect(saved).toEqual([
      expect.objectContaining({ id: 't0', relevance: 0.4, reasonSkipped: false }),
    ]);
    const judgeStage = mockBuildJudgeCalls.mock.calls[0][0] as any[];
    expect(judgeStage.map((c) => c.input.id)).toEqual(['t0']);
  });
});

describe('top-headline cull — legacy path', () => {
  // Force the BACKSTOP relevance path (see the apply-step describe: the global
  // beforeEach does not reset computeMathStage, so a prior judge-mode test would
  // otherwise route decode to handleJudgeResults).
  beforeEach(() => {
    mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
      persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
      stage: candidates.map((c) => ({ input: { id: c.id } })),
      computedScoreMap: new Map(),
      componentsMap: new Map(),
      modeMap: new Map(candidates.map((c) => [c.id, 'backstop'])),
    }));
  });

  /** Enqueue with NO headline rows visible (one standard partition = one batch),
   *  then reveal the scopes so only the decode's lookupHeadlineIds sees them. */
  async function waitingBatchWithHeadlines(
    batchIds: string[],
    headlineIds: string[],
  ) {
    await enqueueCandidates(batchIds);
    const batch = currentRun().batches[0];
    expect(batch.phase).toBe('waiting-relevance');
    mockGetStageRowsByIds.mockResolvedValue(
      batchIds.map((id) => ({
        id,
        headlineScope: headlineIds.includes(id) ? 'GLOBAL' : null,
      })),
    );
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    return batch;
  }

  it('excludes a LOW headline instead of saving it, and keeps it out of the reason + discard maps', async () => {
    const batch = await waitingBatchWithHeadlines(['h0', 't0'], ['h0']);
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['h0', 0.4], ['t0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([
      { ...candidate('t0'), relevance: 0.8 },
    ]);

    await handlePush(batch.requestId, 'foreground');

    expect(mockBatchMarkExcluded).toHaveBeenCalledWith(['h0']);
    expect(mockSaveScoringResult).not.toHaveBeenCalledWith('h0', expect.anything());
    expect(mockSaveScoringResult).toHaveBeenCalledWith(
      't0',
      expect.objectContaining({ relevance: 0.8 }),
    );
    const b = currentRun().batches[0];
    expect(b.relevanceMap).toEqual({ t0: 0.8 });
    expect(b.rawRelevanceMap).toEqual({ t0: 0.8 });
    expect(b.reasonCandidateIds).toEqual(['t0']);
  });

  it('leaves a MEDIUM headline alone (saved + reason-eligible as normal)', async () => {
    const batch = await waitingBatchWithHeadlines(['h0'], ['h0']);
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['h0', 0.6]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([
      { ...candidate('h0'), relevance: 0.6 },
    ]);

    await handlePush(batch.requestId, 'foreground');

    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).toHaveBeenCalledWith(
      'h0',
      expect.objectContaining({ relevance: 0.6, reason: '' }),
    );
    expect(currentRun().batches[0].reasonCandidateIds).toEqual(['h0']);
  });

  it('never culls a topic-matched row at the same LOW score', async () => {
    const batch = await waitingBatchWithHeadlines(['t0'], []);
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['t0', 0.4]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([
      { ...candidate('t0'), relevance: 0.4 },
    ]);

    await handlePush(batch.requestId, 'foreground');

    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).toHaveBeenCalledWith(
      't0',
      expect.objectContaining({ relevance: 0.4 }),
    );
    expect(currentRun().batches[0].reasonCandidateIds).toEqual(['t0']);
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

  // --- coverage: the articles a run REALLY analyses -----------------------
  // The gate enqueues one elected representative per duplicate story group, so
  // the candidate count is a fraction of the articles being analysed. Batches
  // carry the covered ids so the header can count articles, not representatives.

  it('counts the held-back siblings a representative covers, not just the candidates', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          // 1 candidate standing in for a group of 3, plus a singleton.
          {
            phase: 'done',
            candidateIds: ['rep'],
            coveredIds: ['rep', 'sib1', 'sib2'],
          },
          { phase: 'waiting-relevance', candidateIds: ['solo'], coveredIds: ['solo'] },
        ]),
      ),
    ).toEqual({ done: 3, total: 4 });
  });

  it('unions overlapping covered sets so a re-elected sibling is not double-counted', () => {
    // A held-back sibling is not in-flight, so the next gate pass elects IT and
    // enqueues it in a batch of its own — its id legitimately appears twice.
    // Summing would report 5 articles for 3.
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'waiting-relevance', candidateIds: ['rep'], coveredIds: ['rep', 'sib1', 'sib2'] },
          { phase: 'queued', candidateIds: ['sib1'], coveredIds: ['sib1', 'sib2'] },
        ]),
      ),
    ).toEqual({ done: 0, total: 3 });
  });

  it('falls back to candidateIds for batches persisted before coveredIds shipped', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'done', candidateIds: ['a', 'b'] }, // legacy: no coveredIds
          { phase: 'waiting-relevance', candidateIds: ['c'], coveredIds: ['c', 'c-sib'] },
        ]),
      ),
    ).toEqual({ done: 2, total: 4 });
  });

  it('is immune to the submit-time candidateIds shrink (coveredIds is never rewritten)', () => {
    // The backstop path replaces candidateIds with the eligible subset at
    // submit; the denominator must not shrink underneath the user.
    const before = derivePipelineBatchProgress(
      makeRun([
        { phase: 'queued', candidateIds: ['a', 'b', 'c'], coveredIds: ['a', 'b', 'c'] },
        { phase: 'waiting-relevance', candidateIds: ['z'], coveredIds: ['z'] },
      ]),
    );
    const afterShrink = derivePipelineBatchProgress(
      makeRun([
        { phase: 'queued', candidateIds: ['a'], coveredIds: ['a', 'b', 'c'] },
        { phase: 'waiting-relevance', candidateIds: ['z'], coveredIds: ['z'] },
      ]),
    );
    expect(afterShrink).toEqual(before);
    expect(afterShrink.total).toBe(4);
  });
});


// ---------------------------------------------------------------------------
// apply-step throw → attempt cap (MERA-APP-53/55)
//
// A throw in the apply step (decode/save racing a row deleted underneath the
// batch) used to leave the batch in waiting-* with no attempt++ and no terminal
// transition, so the 7s poller re-fetched the SAME server-cached results and
// re-threw on every tick for up to RUN_ABANDON_MS (24h) — one production device
// looping. The apply catch now routes through requeueWaitingOrFail so the batch
// terminates after MAX_BATCH_ATTEMPTS.
// ---------------------------------------------------------------------------

describe('apply-step throw → attempt cap (MERA-APP-53/55)', () => {
  // Force the BACKSTOP relevance path so the apply step runs decodeResults (the
  // throw seam below). The global beforeEach does NOT reset computeMathStage, so
  // a prior judge-mode test could otherwise leave it returning math-mode
  // candidates → the judge decode path, bypassing decodeResults entirely.
  beforeEach(() => {
    mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
      persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
      stage: candidates.map((c) => ({ input: { id: c.id } })),
      computedScoreMap: new Map(),
      componentsMap: new Map(),
      modeMap: new Map(candidates.map((c) => [c.id, 'backstop'])),
    }));
  });

  // Restore the throwing decode/fetch impls so they can't leak into later tests
  // (a mockImplementation wins over the beforeEach mockReturnValue default).
  afterEach(() => {
    mockDecodeResults.mockReset();
    mockFetchResults.mockReset();
  });

  it('terminates a poisoned waiting-relevance batch after MAX_BATCH_ATTEMPTS instead of re-throwing forever', async () => {
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];
    expect(batch.phase).toBe('waiting-relevance');

    // Server returns the same cached results on every poll; the apply step
    // (decodeResults) throws every time — the exact loop the fix bounds.
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    // Reset first so the throwing impl replaces the beforeEach mockReturnValue
    // default (a lingering return value would otherwise win).
    mockDecodeResults.mockReset();
    mockDecodeResults.mockImplementation(() => {
      throw new Error('Record article_suggestions#a0 not found');
    });

    // Poll 1: apply throws → attempt 1 (< MAX=2) → requeued to queued, re-drained
    // → back in flight (submit succeeds via the default mocks).
    await handlePush(batch.requestId, 'foreground');
    const afterFirst = currentRun()?.batches[0];
    expect(afterFirst).toBeDefined();
    expect(afterFirst.attempt).toBe(1);
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(
      afterFirst.phase,
    );

    // Poll 2: apply throws again → attempt 2 (== MAX) → failed → single batch →
    // run finalized + cleared, so the poller stops re-driving it.
    jest.setSystemTime(NOW + 20_000);
    const b1 = currentRun().batches[0];
    await handlePush(b1.requestId, 'foreground');

    const finalBatch = currentRun()?.batches[0];
    expect(finalBatch === undefined || finalBatch.phase === 'failed').toBe(true);
  });

  it('bounds the apply captureException to at most MAX_BATCH_ATTEMPTS per batch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logger = require('@/lib/logger').default;
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];

    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    mockDecodeResults.mockReset();
    mockDecodeResults.mockImplementation(() => {
      throw new Error('boom');
    });

    (logger.captureException as jest.Mock).mockClear();
    await handlePush(batch.requestId, 'foreground'); // attempt 1
    jest.setSystemTime(NOW + 20_000);
    const b1 = currentRun()?.batches[0];
    if (b1) await handlePush(b1.requestId, 'foreground'); // attempt 2 → failed

    const applyCaptures = (logger.captureException as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1]?.tags?.step === 'apply',
    );
    // Fired for the poisoned applies but bounded (≤ MAX_BATCH_ATTEMPTS), not forever.
    expect(applyCaptures.length).toBeGreaterThanOrEqual(1);
    expect(applyCaptures.length).toBeLessThanOrEqual(2);
    // The run is terminal now → no further polling of this batch.
    expect(currentRun()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P4b — headline/standard batch homogeneity + the persisted chunk size.
//
// A batch becomes ONE inference request whose `score:N` calls the decoder
// rebuilds by re-chunking `candidateIds`. Headline candidates chunk at 3 and
// standard ones at 5, so a MIXED batch would need two sizes and the decoder,
// applying one, would attribute scores to the WRONG articles — silently. These
// tests pin (a) a mixed enqueue never produces a mixed batch, and (b) the size
// the submit actually used is persisted and is what decode re-chunks with.
// ---------------------------------------------------------------------------

describe('P4b — headline batch partitioning + chunk-size round trip', () => {
  const HEADLINE_CHUNK = 3;

  /** Stage rows as getStageRowsByIds returns them (only the field we read). */
  function stageRows(headlineIds: string[], standardIds: string[] = []) {
    return [
      ...headlineIds.map((id) => ({ id, headlineScope: 'GLOBAL' })),
      ...standardIds.map((id) => ({ id, headlineScope: null })),
    ];
  }

  /** Mirror of the real builder: variant (and therefore chunk size) derived
   *  from the candidates, reported back on the bundle. */
  function realisticRelevanceBuilder() {
    return jest.fn(async (subset: any[]) => {
      const allHeadline =
        subset.length > 0 &&
        subset.every((c) => c.meta?.headlineScope === 'GLOBAL');
      const size = allHeadline ? HEADLINE_CHUNK : 5;
      return {
        calls: Array.from(
          { length: Math.max(1, Math.ceil(subset.length / size)) },
          (_, i) => ({ id: `score:${i}`, system: 's', prompt: 'p' }),
        ),
        eligibleCandidates: subset,
        promptsById: new Map(),
        chunkIdToCandidates: new Map(),
        scoreChunkSize: size,
      };
    });
  }

  /** getUnscored, with meta attached for the ids the stage lookup called out. */
  function unscoredWithMeta(headlineIds: Set<string>) {
    return async () => {
      const all = new Set<string>();
      if (mockRun) {
        for (const b of mockRun.batches) for (const id of b.candidateIds) all.add(id);
      }
      return Array.from(all).map((id) => ({
        ...candidate(id),
        meta: { id, headlineScope: headlineIds.has(id) ? 'GLOBAL' : null },
      }));
    };
  }

  it('never puts a headline and a standard candidate in the same batch', async () => {
    const headlineIds = ['h0', 'h1', 'h2', 'h3'];
    const standardIds = ['s0', 's1', 's2', 's3', 's4', 's5'];
    // Interleaved arrival order — the partition must survive it.
    const arrival = ['s0', 'h0', 's1', 'h1', 's2', 'h2', 's3', 'h3', 's4', 's5'];
    mockGetStageRowsByIds.mockResolvedValue(stageRows(headlineIds, standardIds));

    await enqueueCandidates(arrival);

    const run = currentRun();
    expect(run.batches.length).toBeGreaterThanOrEqual(2);
    const hs = new Set(headlineIds);
    for (const b of run.batches) {
      const flags = new Set(b.candidateIds.map((id: string) => hs.has(id)));
      expect(flags.size).toBe(1); // all-headline OR all-standard, never both
    }
    // Nothing lost, nothing duplicated.
    expect(run.batches.flatMap((b: any) => b.candidateIds).sort()).toEqual(
      [...arrival].sort(),
    );
  });

  it('keeps delivery order within each partition', async () => {
    const arrival = ['s0', 'h0', 's1', 'h1', 's2', 'h2', 's3', 'h3', 's4'];
    mockGetStageRowsByIds.mockResolvedValue(
      stageRows(['h0', 'h1', 'h2', 'h3'], ['s0', 's1', 's2', 's3', 's4']),
    );

    await enqueueCandidates(arrival);

    const run = currentRun();
    const flat = run.batches.flatMap((b: any) => b.candidateIds);
    expect(flat.filter((id: string) => id.startsWith('s'))).toEqual([
      's0', 's1', 's2', 's3', 's4',
    ]);
    expect(flat.filter((id: string) => id.startsWith('h'))).toEqual([
      'h0', 'h1', 'h2', 'h3',
    ]);
  });

  it('dispatches a headline partition at its own (smaller) floor — one LLM call', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh → no escape
    mockGetStageRowsByIds.mockResolvedValue(stageRows(['h0', 'h1', 'h2']));

    // 3 < MIN_DISPATCH (5) but == MIN_DISPATCH_HEADLINE, so it goes out now.
    const res = await enqueueCandidates(['h0', 'h1', 'h2']);

    expect(res.deferred).toEqual([]);
    expect(currentRun().batches[0].candidateIds).toEqual(['h0', 'h1', 'h2']);
  });

  it('caps a headline batch at MAX_BATCH_ARTICLES_HEADLINE (10 calls, not 17)', async () => {
    const headlineIds = ids(MAX_BATCH_ARTICLES_HEADLINE + MIN_DISPATCH_HEADLINE, 'h');
    mockGetStageRowsByIds.mockResolvedValue(stageRows(headlineIds));

    await enqueueCandidates(headlineIds);

    const run = currentRun();
    expect(run.batches[0].candidateIds).toHaveLength(MAX_BATCH_ARTICLES_HEADLINE);
    expect(run.batches[1].candidateIds).toHaveLength(MIN_DISPATCH_HEADLINE);
  });

  it('persists the chunk size the submit ACTUALLY used, per variant', async () => {
    const headlineIds = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5'];
    const standardIds = ['s0', 's1', 's2', 's3', 's4'];
    mockGetStageRowsByIds.mockResolvedValue(stageRows(headlineIds, standardIds));
    mockGetUnscored.mockImplementation(unscoredWithMeta(new Set(headlineIds)));
    mockBuildRelevanceCalls.mockImplementation(realisticRelevanceBuilder());

    await enqueueCandidates([...standardIds, ...headlineIds]);

    const run = currentRun();
    const byKind = new Map<boolean, any>();
    for (const b of run.batches) {
      byKind.set(b.candidateIds[0].startsWith('h'), b);
    }
    expect(byKind.get(false).scoreChunkSize).toBe(5);
    expect(byKind.get(true).scoreChunkSize).toBe(HEADLINE_CHUNK);
  });

  it('decodes a headline batch with the PERSISTED size, not the standard one', async () => {
    const headlineIds = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5'];
    mockGetStageRowsByIds.mockResolvedValue(stageRows(headlineIds));
    mockGetUnscored.mockImplementation(unscoredWithMeta(new Set(headlineIds)));
    mockBuildRelevanceCalls.mockImplementation(realisticRelevanceBuilder());

    await enqueueCandidates(headlineIds);
    const batch = currentRun().batches[0];
    expect(batch.phase).toBe('waiting-relevance');
    expect(batch.scoreChunkSize).toBe(HEADLINE_CHUNK);

    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [
        { id: 'score:0', ok: true },
        { id: 'score:1', ok: true },
      ],
    });
    mockReconstructLookups.mockClear();

    await handlePush(batch.requestId, 'foreground');

    // 6 ids / 3 = 2 chunks (a 5-chunking would have produced 2 chunks too, but
    // with the WRONG boundaries) — assert the size that was actually passed.
    expect(mockReconstructLookups).toHaveBeenCalledWith(
      ['score:0', 'score:1'],
      headlineIds,
      HEADLINE_CHUNK,
    );
  });

  it('decodes a pre-P4b batch (no persisted size) with the standard size', async () => {
    await enqueueCandidates(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    // Strip the field from the persisted record — exactly the shape a batch
    // submitted by a PRE-P4b build rehydrates with while still in flight.
    delete mockRun.batches[0].scoreChunkSize;
    const batch = currentRun().batches[0];
    expect(batch.scoreChunkSize).toBeUndefined();

    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }, { id: 'score:1', ok: true }],
    });
    mockReconstructLookups.mockClear();

    await handlePush(batch.requestId, 'foreground');

    expect(mockReconstructLookups).toHaveBeenCalledWith(
      expect.any(Array),
      ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'],
      5,
    );
  });

  it('falls back to one standard partition when the stage lookup throws', async () => {
    mockGetStageRowsByIds.mockRejectedValue(new Error('db gone'));

    await enqueueCandidates(ids(MIN_DISPATCH, 'x'));

    const run = currentRun();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });
});
