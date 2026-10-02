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
const mockFinalizeStranded = jest.fn(async (..._a: any[]) => 0);
const mockToBatchResult = jest.fn((...args: any[]) => ({ id: args[0].id, output: 'out' }));
const mockReconstructLookups = jest.fn((..._args: any[]) => ({ chunkIdToCandidates: new Map() }));
// Story-grouping gate + post-results sibling propagation. Mocked wholesale:
// the real module reaches the WatermelonDB graph at import time, and every
// assertion here is about how the ORCHESTRATOR uses the gate, not about the
// election rules (which score-propagation's own suite covers).
const mockGateUnscoredForScoring = jest.fn();
const mockPropagateToUnscoredSiblings = jest.fn();
// v3 merged pass: the user's fact bank (lazy-required) + the hard-filter sweep
// the gate reconcile runs + the geo/language context the election reads.
const mockGetFacts = jest.fn();
const mockPurgeHardFilteredSuggestions = jest.fn();
const mockLoadUserGeoLanguageContext = jest.fn();
const mockGetExpoPushToken = jest.fn(() => 'ExponentPushToken[test]');
const mockSetAsyncJobPhase = jest.fn();
const mockSetBatchProgress = jest.fn();
const mockMarkProcessingRunFinished = jest.fn();
const mockSetReasonsInFlightIds = jest.fn();
const mockGetGroupingRowsByIds = jest.fn(async (..._args: any[]) => [] as any[]);
const mockBatchPropagateScores = jest.fn(async (..._args: any[]) => undefined);

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
  MIN_GATEWAY_INTERVAL_MS: 1000,
  tryTakeImmediate: (...args: any[]) => mockTryTakeImmediate(...args),
  pauseFor: (...args: any[]) => mockPauseFor(...args),
  acquire: (...args: any[]) => mockAcquire(...args),
  // Read-only: startPollerTimer aligns its FIRST tick to this instead of a
  // fixed POLL_INTERVAL_MS. 0 ⇒ "a grant is free now", which under fake timers
  // keeps the first tick at ~0ms and leaves existing tick-count assertions
  // (driven by advanceTimersByTime) unchanged.
  msUntilNextGrant: () => 0,
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
  class NoCredentialError extends Error {
    constructor(message = 'no credential') {
      super(message);
      this.name = 'NoCredentialError';
      Object.setPrototypeOf(this, NoCredentialError.prototype);
    }
  }
  return {
    ModelKeyValidationError,
    NoCredentialError,
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
  getGroupingRowsByIds: (...args: any[]) => mockGetGroupingRowsByIds(...args),
  batchPropagateScores: (...args: any[]) => mockBatchPropagateScores(...args),
}));

// Round-3: fact-grouping snapshot loader (lazy-required in planFactBatches).
jest.mock('@/lib/stores/section-snapshots', () => ({
  loadSectionSnapshots: (...args: any[]) => mockLoadSectionSnapshots(...args),
}));


// stage-scoring pulls in the persona DB services + auth chain at import time;
// mock it so the pipeline module loads without native deps. Default drives the
// legacy backstop path (see mockComputeMathStage above).
jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  computeMathStage: (...args: any[]) => mockComputeMathStage(...args),
  effectiveHarnessConfig: (...args: any[]) => mockEffectiveHarnessConfig(...args),
}));

// EVERY name scoring-pipeline imports from here must appear below. The module
// is replaced wholesale, so an import this factory omits arrives as `undefined`
// at the call site, and the per-row try/catch around the reason writes swallows
// the resulting TypeError and reports it as a save failure. That is a whole
// afternoon if you have not seen it before.
jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  // The REAL bucketing, not a stub: these tests assert which band a rescore
  // lands in, and a stubbed bucketer would be asserting the stub.
  bucketScore: jest.requireActual('@/lib/news-harness/article-pipeline/scoring').bucketScore,
  bucketScores: (...args: any[]) => mockBucketScores(...args),
  buildRelevanceCalls: (...args: any[]) => mockBuildRelevanceCalls(...args),
  buildReasonCallsForSubset: (...args: any[]) => mockBuildReasonCallsForSubset(...args),
  decodeResults: (...args: any[]) => mockDecodeResults(...args),
  runFeedVerifierPass: (...args: any[]) => mockRunFeedVerifierPass(...args),
  CLOUD_SCORE_CHUNK_SIZE: 5,
  REASON_MIN_RAW_SCORE: 0.3,
}));

jest.mock('@/lib/feed-grouping/score-propagation', () => ({
  gateUnscoredForScoring: (...args: any[]) => mockGateUnscoredForScoring(...args),
  propagateToUnscoredSiblings: (...args: any[]) => mockPropagateToUnscoredSiblings(...args),
}));

jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: (...args: any[]) => mockGetFacts(...args),
}));

jest.mock('@/lib/services/suppression-sweep', () => ({
  purgeHardFilteredSuggestions: (...args: any[]) => mockPurgeHardFilteredSuggestions(...args),
  purgeHardFilteredByIds: jest.fn(async () => undefined),
}));

jest.mock('@/lib/user-context/user-geo-language-context', () => ({
  loadUserGeoLanguageContext: (...args: any[]) => mockLoadUserGeoLanguageContext(...args),
}));

// The pipeline reads the processing mode (on-device sends no new cloud work).
// The real store imports the WatermelonDB-backed setting service at load time.
let mockProcessingMode = 'CLOUD';
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ processingMode: mockProcessingMode }) },
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
      setChunkStates: jest.fn(),
      setReasonsInFlightIds: mockSetReasonsInFlightIds,
      markProcessingRunFinished: mockMarkProcessingRunFinished,
    }),
  },
}));

jest.mock('@/lib/services/inference-results', () => ({
  discardLowRelevance: (...args: any[]) => mockDiscardLowRelevance(...args),
  finalizeStrandedBelowReasonThreshold: (...args: any[]) => mockFinalizeStranded(...args),
  fetchResults: (...args: any[]) => mockFetchResults(...args),
  hexToBytes: () => new Uint8Array([1, 2, 3, 4]),
  isRecordNotFoundError: (err: unknown) =>
    /Record\s+\S+\s+not\s+found/i.test(err instanceof Error ? err.message : String(err)),
  reconstructLookups: (...args: any[]) => mockReconstructLookups(...args),
  toBatchResult: (...args: any[]) => mockToBatchResult(...args),
  // Mirrors the REAL constant (relevance v3 raised it 0.3 → 0.4 in lockstep with
  // RENDER_GATE). Keep the two in sync: a stale value here silently tests a
  // reason/discard boundary the app no longer has.
  REASON_RELEVANCE_THRESHOLD: 0.4,
  TaskNoAuthError: class TaskNoAuthError extends Error {},
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
  derivePipelineChunkStates,
  isFeedCold,
  _resetForTests,
  BATCH_SIZE,
  MAX_UNSCORED_WAIT_MS,
  MIN_DISPATCH,
  MAX_BATCH_ARTICLES,
  advanceWaitingForBackground,
  submitScoringForBackground,
  staleRunVerdict,
  deriveStaleRunVerdict,
  deriveReasonsInFlightIds,
  getReasonsInFlightIds,
  COLLECT_WINDOW_MS,
  rampedBatchCap,
  pickNextGatewayAction,
  pendingPollKey,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_TOTAL,
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
  // Restore the ALL-BACKSTOP default explicitly: jest.clearAllMocks() clears
  // recorded calls but NOT implementations, so a test that installed a math-mode
  // (or v3) stage would otherwise leak its candidate filter into every test
  // after it — which silently marks unrelated batches "fully hard-filtered".
  mockComputeMathStage.mockImplementation(async (candidates: any[] = []) => ({
    persona: { locations: [], pubPrefs: new Map(), softSuppressions: [] },
    stage: candidates.map((c) => ({ input: { id: c.id } })),
    computedScoreMap: new Map(),
    componentsMap: new Map(),
    modeMap: new Map(candidates.map((c) => [c.id, 'backstop'])),
  }));
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
  // Gate default: no duplicates anywhere — every unscored row is its own
  // singleton representative, which is the pre-gate-routing behaviour every
  // existing enqueue assertion in this file was written against.
  mockGateUnscoredForScoring.mockImplementation(async () => {
    const rows = await mockGetUnscored();
    const enqueueIds = rows.map((c: any) => c.id);
    const coveredIdsByRep: Record<string, string[]> = {};
    for (const id of enqueueIds) coveredIdsByRep[id] = [id];
    return { enqueueIds, propagatedCount: 0, heldBackCount: 0, coveredIdsByRep };
  });
  mockPropagateToUnscoredSiblings.mockResolvedValue(0);
  mockGetFacts.mockResolvedValue([{ statement: 'I live in Amsterdam' }]);
  mockPurgeHardFilteredSuggestions.mockResolvedValue(undefined);
  mockLoadUserGeoLanguageContext.mockResolvedValue(null);
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
    await enqueueCandidates(ids(5 + 10 + 25 + 50)); // 4 ramped batches

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

  it('attaches the push token to the first and the last relevance submit only', async () => {
    // 3 ramped batches (5, 10, 25), all admitted (MAX_IN_FLIGHT >= 3).
    await enqueueCandidates(ids(5 + 10 + 25));

    // batch 0 is the run's first → token (its push wakes the first cards).
    // batch 1 submitted while batch 2 still queued → no token.
    // batch 2 submitted last → token.
    const tokens = mockSendInferenceRequest.mock.calls.map((c: any[]) => c[0].token);
    expect(tokens).toEqual(['ExponentPushToken[test]', null, 'ExponentPushToken[test]']);
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

    await enqueueCandidates(ids(5 + 10)); // 2 ramped batches

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
describe('on-device mode sends no new work to the cloud', () => {
  afterEach(() => {
    mockProcessingMode = 'CLOUD';
  });

  it('enqueueCandidates is a no-op in on-device mode', async () => {
    mockProcessingMode = 'ON_DEVICE';
    const res = await enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES));
    expect(res).toEqual({ deferred: [] });
    expect(currentRun()).toBeNull();
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    expect(mockPrepareE2EEContext).not.toHaveBeenCalled();
  });

  it('enqueueOrphanedReasons is a no-op in on-device mode', async () => {
    mockProcessingMode = 'ON_DEVICE';
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('o0'), relevance: 0.8 }]);
    await enqueueOrphanedReasons();
    expect(currentRun()).toBeNull();
    expect(mockGetScoredWithoutReasons).not.toHaveBeenCalled();
  });

  it('the same enqueue still dispatches in cloud mode (the guard is mode-specific)', async () => {
    await enqueueCandidates(ids(MAX_BATCH_ARTICLES));
    expect(currentRun()).not.toBeNull();
    expect(mockSendInferenceRequest).toHaveBeenCalled();
  });
});

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

  it('ramps batch sizes 1, 2, 5, then 10 calls so the first cards wait on ONE call', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);

    await enqueueCandidates(ids(5 + 10 + 25 + 50 + 50 + MIN_DISPATCH));

    const sizes = currentRun().batches.map((b: any) => b.candidateIds.length);
    expect(sizes).toEqual([5, 10, 25, 50, 50, MIN_DISPATCH]);
    expect(sizes[3]).toBe(MAX_BATCH_ARTICLES);
  });

  it('rampedBatchCap repeats the last step and never exceeds the ceiling', () => {
    expect([0, 1, 2, 3, 4, 9].map((r) => rampedBatchCap(r, 5, MAX_BATCH_ARTICLES))).toEqual([
      5, 10, 25, 50, 50, 50,
    ]);
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

    // The append continues the run's ramp at position 1 (10), then 2 (25).
    const res = await enqueueCandidates(ids(10 + 25 + MIN_DISPATCH - 1, 'more'));

    const run = currentRun();
    expect(run.batches.map((b: any) => b.candidateIds.length)).toEqual([MIN_DISPATCH, 10, 25]);
    expect(res.deferred).toHaveLength(MIN_DISPATCH - 1);
  });

  it('enqueueOrphanedReasons finalizes stranded sub-threshold rows before queueing reasons', async () => {
    const rows = [
      { ...candidate('s1'), relevance: 0.35 },
      { ...candidate('ok'), relevance: 0.8 },
    ];
    mockGetScoredWithoutReasons.mockResolvedValue(rows);

    await enqueueOrphanedReasons();

    expect(mockFinalizeStranded).toHaveBeenCalledTimes(1);
    expect(mockFinalizeStranded.mock.calls[0][0]).toEqual(rows);
    const run = currentRun();
    // Only the 0.8 row is queued for a reason; the 0.35 one never is.
    const queued = run.batches.flatMap((b: any) => b.candidateIds);
    expect(queued).toEqual(['ok']);
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
// STALE v3 BATCH — the upgrade window.
//
// The v3 scorer is deleted, but a device that had the beta ON when this build
// landed can still hold a persisted batch submitted under it, sitting in
// `waiting-relevance`. Its results are a DIFFERENT output contract (one merged
// call returning {"i","rel","impact","why"?} per article) from the legacy
// `score:N` chunks. Handing them to the legacy decoder would NOT fail loudly —
// it would write garbage scores onto real rows.
//
// This is the only new behaviour in the v3→v4 change that executes solely on a
// real device during an upgrade, so nothing else would catch a regression here.
// ---------------------------------------------------------------------------

describe('batch from a retired scorer (still in flight across the upgrade)', () => {
  async function waitingBatchMarked(marker: 'v3Mode' | 'judgeMode') {
    await enqueueCandidates(['a0', 'a1']);
    const batch = mockRun.batches[0];
    expect(batch.phase).toBe('waiting-relevance');
    // Nothing in this build writes either marker — only a pre-upgrade run could
    // carry one — so it is injected directly into the persisted run.
    mockRun.batches[0][marker] = true;
    return { ...batch, [marker]: true };
  }

  const waitingBatchMarkedV3 = () => waitingBatchMarked('v3Mode');

  it('never decodes it — requeues instead of writing garbage scores', async () => {
    const batch = await waitingBatchMarkedV3();
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    mockDecodeResults.mockClear();
    mockSaveScoringResult.mockClear();

    await handlePush(batch.requestId, 'foreground');

    // The legacy decoder was never reached, and no score was persisted.
    expect(mockDecodeResults).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
  });

  it('requeues rather than failing, so the rows are RE-SCORED not merely dropped', async () => {
    const batch = await waitingBatchMarkedV3();
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    // attempt 1 of MAX_BATCH_ATTEMPTS ⇒ requeued (not failed). A
    // waiting-relevance failure persists nothing, so the rows stay `unscored`
    // either way — but requeueing re-submits them down the legacy path in THIS
    // run instead of leaving them for the next one.
    const b = mockRun.batches[0];
    expect(b.attempt).toBe(1);
    expect(b.phase).toBe('waiting-relevance'); // requeued → drained → in flight again
    expect(b.candidateIds).toEqual(['a0', 'a1']);
  });

  // The JUDGE is the second retired scorer. Its marker is a first-class
  // persisted field (`PipelineBatch.judgeMode`), not an ad-hoc annotation, and
  // its results were a {"j","s"?,"r"?} array rather than `score:N` chunks — a
  // different contract from the legacy decoder, exactly like v3's.
  //
  // Unlike v3 no SHIPPED build could have produced one (judge mode required
  // `EXPO_PUBLIC_USE_ARTICLE_TAGS=true`, unset in `.env`), so this covers
  // dev/staging devices rather than a real upgrade population. It costs one
  // predicate.
  it('also catches a judge-mode batch, and never decodes it', async () => {
    const batch = await waitingBatchMarked('judgeMode');
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    mockDecodeResults.mockClear();
    mockSaveScoringResult.mockClear();

    await handlePush(batch.requestId, 'foreground');

    expect(mockDecodeResults).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
    expect(mockRun.batches[0].attempt).toBe(1);
  });

  it('clears the judge marker on resubmit — the detector cannot loop', async () => {
    const batch = await waitingBatchMarked('judgeMode');
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    expect(mockRun.batches[0].judgeMode).toBeUndefined();
  });

  it('clears the v3 marker on resubmit — the detector cannot loop', async () => {
    const batch = await waitingBatchMarkedV3();
    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });

    await handlePush(batch.requestId, 'foreground');

    // `transitionToWaitingRelevance` clears `v3Mode` UNCONDITIONALLY. Without
    // that, the requeued batch would carry the marker straight back into
    // waiting-relevance and trip the detector again every cycle until its
    // attempts ran out — turning a one-off upgrade hiccup into a dead batch.
    expect(mockRun.batches[0].v3Mode).toBeUndefined();
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
      rescoreMap: new Map(),
    });
    mockFetchResults.mockResolvedValueOnce({ requestId: reasonsBatch.requestId, results: [{ id: 'reason:a0', ok: true }] });

    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'because it matters');
    expect(mockDiscardLowRelevance).toHaveBeenCalled();
    // single batch → finalized + cleared
    expect(currentRun()).toBeNull();
  });

  // --- pass-2 rescore -------------------------------------------------------
  //
  // When pass 2 returns a score as well as a sentence, the two are written in
  // ONE update through `saveScoringResult` rather than a reason write landing
  // beside a score the reason contradicts. `saveScoringResult` also re-stamps
  // `scored_with_v3` from the same predicate the pass-1 write used, so the
  // row's render gate cannot change under it mid-life.

  /** Drive one batch to `waiting-reasons` with `a0` scored 0.8. */
  const toWaitingReasons = async () => {
    await enqueueCandidates(['a0']);
    const batch = currentRun().batches[0];
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
      rescoreMap: new Map(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([
      { ...candidate('a0'), relevance: 0.8 },
    ]);
    mockFetchResults.mockResolvedValueOnce({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    await handlePush(batch.requestId, 'foreground');
    return currentRun().batches[0];
  };

  /** Complete the reason job with this decode. */
  const completeReasons = async (
    reasonsBatch: any,
    decoded: { reasonMap: Map<string, string>; rescoreMap: Map<string, number> },
  ) => {
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(),
      failedIds: new Set(),
      ...decoded,
    });
    mockSaveScoringResult.mockClear();
    mockSaveReason.mockClear();
    mockDiscardLowRelevance.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [{ id: 'reason:a0', ok: true }],
    });
    await handlePush(reasonsBatch.requestId, 'foreground');
  };

  it('writes the reason AND the bucketed rescore in one saveScoringResult', async () => {
    const reasonsBatch = await toWaitingReasons();
    await completeReasons(reasonsBatch, {
      reasonMap: new Map([['a0', 'A foreign domestic vote, no tie to your country.']]),
      // 0.16 is `none` band: below the 0.4 discard floor, so it buckets to
      // itself and the card leaves the feed.
      rescoreMap: new Map([['a0', 0.16]]),
    });

    expect(mockSaveReason).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).toHaveBeenCalledWith('a0', {
      relevance: 0.16,
      reason: 'A foreign domestic vote, no tie to your country.',
      reasonSkipped: false,
    });
  });

  it('buckets an ABOVE-gate rescore instead of persisting the raw value', async () => {
    const reasonsBatch = await toWaitingReasons();
    await completeReasons(reasonsBatch, {
      reasonMap: new Map([['a0', 'Drought rules start Monday, where you live.']]),
      rescoreMap: new Map([['a0', 0.93]]),
    });
    // The feed renders four representative values, not a continuum, so a raw
    // 0.93 has to arrive as the HIGH band's score like every other score does.
    const [, params] = mockSaveScoringResult.mock.calls[0];
    expect(params.relevance).toBe(0.8);
    expect(params.reasonSkipped).toBe(false);
  });

  it('hands the NEW score to discardLowRelevance, not the stored one', async () => {
    const reasonsBatch = await toWaitingReasons();
    await completeReasons(reasonsBatch, {
      reasonMap: new Map([['a0', 'A foreign domestic vote, no tie to your country.']]),
      rescoreMap: new Map([['a0', 0.16]]),
    });
    // The batch was STORED at 0.8. Passing that map would leave the row's
    // bookkeeping claiming a keep that its persisted relevance contradicts.
    const [, relevanceMap] = mockDiscardLowRelevance.mock.calls[0];
    expect(relevanceMap.a0).toBe(0.16);
  });

  it('falls back to saveReason when the response carried no score', async () => {
    const reasonsBatch = await toWaitingReasons();
    await completeReasons(reasonsBatch, {
      reasonMap: new Map([['a0', 'because it matters']]),
      rescoreMap: new Map(),
    });
    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'because it matters');
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
  });

  it('survives a decode that predates rescoreMap entirely', async () => {
    // A missing field must not become `undefined.get(id)` inside the per-row
    // try/catch, where it would be swallowed and reported as a save failure.
    const reasonsBatch = await toWaitingReasons();
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(),
      reasonMap: new Map([['a0', 'because it matters']]),
      failedIds: new Set(),
    });
    mockSaveReason.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [{ id: 'reason:a0', ok: true }],
    });
    await handlePush(reasonsBatch.requestId, 'foreground');
    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'because it matters');
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
    // The staleness clock starts at this process's first check.
    await pollTick('foreground');

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
    // The staleness clock starts at this process's first check.
    await pollTick('foreground');

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

  it('abandons a run idle for longer than RUN_ABANDON_MS and finalizes', async () => {
    await enqueueCandidates(['a0']);
    mockRun.startedAt = NOW - 25 * 3600_000; // > 24h
    for (const b of mockRun.batches) b.submittedAt = NOW - 25 * 3600_000;

    const result = await recover();

    expect(result).toBe('idle');
    expect(currentRun()).toBeNull(); // finalized + cleared
  });

  it('keeps a run that STARTED over 24h ago but submitted recently (measured from last activity)', async () => {
    await enqueueCandidates(['a0']);
    mockRun.startedAt = NOW - 25 * 3600_000;
    mockFetchResults.mockResolvedValue('pending');

    const result = await recover();

    expect(result).toBe('running');
    expect(currentRun()).not.toBeNull();
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

    // A fresh run, so the ramp starts over: 5, 10, then the remaining 10.
    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run.batches.map((b: any) => b.candidateIds.length)).toEqual([5, 10, 10]);
  });

  it('post-finalize kick does nothing when no unscored rows remain', async () => {
    await finalizeSingleBatchRun();
    // mockGetUnscored returns [] while no run exists (default impl) → kick no-ops.
    await jest.advanceTimersByTimeAsync(0);
    expect(currentRun()).toBeNull();
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
    // Same BOUNDARY as the judge path: the reason gate is INCLUSIVE at 0.4, so
    // a row exactly on the LOW cutoff DOES get a reason round trip (renders ⇒
    // reason-eligible) — the batch advances to the reasons phase instead of
    // finalizing at relevance.
    expect(mockBuildReasonCallsForSubset).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 't0', relevance: 0.4 })],
      { t0: 0.4 },
      0.4,
      // LEGACY batch ⇒ the legacy reason prompt, which only writes a note. The
      // NOTE prompt may also DEMOTE, so routing a legacy batch to it would
      // hand rows a verdict their scorer never asked for.
      false,
      // v4 THREADING. The builder used to read `DEFAULT_HARNESS_CONFIG`
      // directly; the effective config now arrives as an argument, which is the
      // only reason the runtime toggle reaches the calls the app sends.
      expect.objectContaining({ legacyTagReasonGateEnabled: false }),
    );
    const run = currentRun();
    expect(run).not.toBeNull();
    expect(run!.batches[0].phase).toBe('waiting-reasons');
    expect(run!.batches[0].reasonCandidateIds).toEqual(['t0']);
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
// Headlines share the ordinary queue + the persisted chunk size.
//
// A batch becomes ONE inference request whose `score:N` calls the decoder
// rebuilds by re-chunking `candidateIds` with the batch's persisted size. Every
// call is now 5 articles, headlines included (the PROMPT is still picked per
// call in buildRelevanceCalls), so headlines queue like any topic's articles.
// Batches persisted by an older build at the headline size of 3 must still
// decode with 3.
// ---------------------------------------------------------------------------

describe('headlines in the ordinary queue + chunk-size round trip', () => {
  it('queues headlines with topic articles, in delivery order', async () => {
    const arrival = ['s0', 'h0', 's1', 'h1', 's2', 'h2', 's3', 'h3', 's4', 's5', 'h4', 'h5', 'h6', 'h7', 'h8'];

    await enqueueCandidates(arrival);

    const run = currentRun();
    expect(run.batches.map((b: any) => b.candidateIds)).toEqual([
      arrival.slice(0, 5),
      arrival.slice(5, 15),
    ]);
    expect(mockGetStageRowsByIds).not.toHaveBeenCalled();
  });

  it('holds a few headlines back at the ordinary floor, like any articles', async () => {
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW); // fresh → no escape

    const res = await enqueueCandidates(['h0', 'h1', 'h2']);

    expect(res.deferred).toEqual(['h0', 'h1', 'h2']);
    expect(currentRun()).toBeNull();
  });

  it('decodes a batch persisted at the old headline size (3) with that size', async () => {
    // Batch 1 holds 10 ids; pretend an older build submitted it at 3 per call.
    await enqueueCandidates(ids(15, 'h'));
    mockRun.batches[1].scoreChunkSize = 3;
    const batch = currentRun().batches[1];

    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [0, 1, 2, 3].map((i) => ({ id: `score:${i}`, ok: true })),
    });
    mockReconstructLookups.mockClear();

    await handlePush(batch.requestId, 'foreground');

    expect(mockReconstructLookups).toHaveBeenCalledWith(
      ['score:0', 'score:1', 'score:2', 'score:3'],
      ids(15, 'h').slice(5),
      3,
    );
  });

  it('decodes a pre-P4b batch (no persisted size) with the standard size', async () => {
    // Batch 1 (10 ids, two chunks of 5) — batch 0 is a single chunk.
    await enqueueCandidates(ids(15, 'a'));
    // Strip the field from the persisted record — exactly the shape a batch
    // submitted by a PRE-P4b build rehydrates with while still in flight.
    delete mockRun.batches[1].scoreChunkSize;
    const batch = currentRun().batches[1];
    expect(batch.scoreChunkSize).toBeUndefined();

    mockFetchResults.mockResolvedValue({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }, { id: 'score:1', ok: true }],
    });
    mockReconstructLookups.mockClear();

    await handlePush(batch.requestId, 'foreground');

    expect(mockReconstructLookups).toHaveBeenCalledWith(
      expect.any(Array),
      ids(15, 'a').slice(5),
      5,
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-bypass fix — enqueueUnscoredEligible now routes through the SAME
// story-grouping gate feed-sync and the background scoring pass use.
// ---------------------------------------------------------------------------

describe('enqueueUnscoredEligible — story-grouping gate routing', () => {
  it('enqueues only the elected representatives, not every eligible row', async () => {
    mockGetUnscored.mockResolvedValue([candidate('rep'), candidate('dup')]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['rep'],
      propagatedCount: 0,
      heldBackCount: 1,
      coveredIdsByRep: { rep: ['rep', 'dup'] },
    });

    const res = await enqueueUnscoredEligible();

    expect(res.enqueued).toBe(1);
    expect(currentRun().batches[0].candidateIds).toEqual(['rep']);
    // The held-back sibling is still COUNTED (the "Analysing X of Y" header).
    expect(currentRun().batches[0].coveredIds).toEqual(['rep', 'dup']);
  });

  it('drops gate ids that are not scorable here (headline-vs-fact predicate still applies)', async () => {
    mockGetUnscored.mockResolvedValue([
      { ...candidate('ok'), relatedFacts: [{ id: 'f', statement: 'f' }] },
      { ...candidate('factless'), relatedFacts: [], meta: { headlineScope: null } },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['ok', 'factless'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { ok: ['ok'], factless: ['factless'] },
    });

    const res = await enqueueUnscoredEligible();

    expect(res.enqueued).toBe(1);
    expect(currentRun().batches[0].candidateIds).toEqual(['ok']);
  });

  it('reconciles hard filters + refreshes when the gate propagated scores', async () => {
    mockGetUnscored.mockResolvedValue([candidate('a0')]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a0'],
      propagatedCount: 3,
      heldBackCount: 0,
      coveredIdsByRep: { a0: ['a0'] },
    });

    await enqueueUnscoredEligible();

    expect(mockPurgeHardFilteredSuggestions).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('enqueues nothing when the gate elects nothing (everything propagated)', async () => {
    mockGetUnscored.mockResolvedValue([candidate('a0')]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: [],
      propagatedCount: 1,
      heldBackCount: 0,
      coveredIdsByRep: {},
    });

    const res = await enqueueUnscoredEligible();

    expect(res.enqueued).toBe(0);
    expect(currentRun()).toBeNull();
  });

  it('still honours the MIN_DISPATCH floor unless flushRemainder is set', async () => {
    // One row, fresh (no staleness escape) → deferred without a flush…
    mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW - 1_000);
    mockGetUnscored.mockResolvedValue([candidate('a0')]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a0'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { a0: ['a0'] },
    });

    await enqueueUnscoredEligible();
    expect(currentRun()).toBeNull();

    // …and dispatched with one.
    await enqueueUnscoredEligible({ flushRemainder: true });
    expect(currentRun().batches[0].candidateIds).toEqual(['a0']);
  });
});

// ---------------------------------------------------------------------------
// legacyNoteDemote — the v3 keep/demote note pass, transplanted onto the LEGACY
// (backstop) path. Measured 2026-08-08 on goldset-348: judge-skip 22.5% → 19.6%,
// recall flat, ZERO net LLM calls (it is the SAME per-article call the legacy
// reason pass already makes — only the system prompt and the decoder differ).
//
// What these pin, in order of what would hurt most if it broke:
//   1. FLAG OFF is byte-identical to before. This is the default, so it is the
//      one that protects every user who has not opted in.
//   2. The decision is captured at SUBMIT and survives the persist round trip.
//      The two prompts have different OUTPUT CONTRACTS, so a batch that sent one
//      and decoded with the other would persist raw JSON as a user-facing note.
//   3. An in-flight batch keeps its own contract even if the live config flips
//      underneath it (an OTA mid-run).
// ---------------------------------------------------------------------------
describe('legacyNoteDemote — the legacy path\'s keep/demote note pass', () => {
  beforeEach(() => {
    // Let the note verdict reach the decoder. The suite's default
    // `toBatchResult` drops `output` (the legacy prose path reads its reasons
    // out of the mocked `decodeResults` instead), but a note verdict IS the
    // output — without this every result decodes as an empty string and the
    // pass fails open on all of them.
    mockToBatchResult.mockImplementation((row: any) => ({
      id: row.id,
      output: row.output ?? '',
      ...(row.ok === false ? { error: 'boom' } : {}),
    }));
  });

  /** The calibrated-config object the legacy submit reads the flag off. */
  const noteConfig = (on: boolean) => ({
    ...DEFAULT_HARNESS_CONFIG,
    articlePipeline: {
      ...DEFAULT_HARNESS_CONFIG.articlePipeline,
      legacyNoteDemote: on,
    },
  });

  /** Drive one legacy (backstop) candidate through relevance into the reasons
   *  phase, which is where the note prompt is chosen. */
  async function legacyToReasonPhase(id: string, relevance: number) {
    await enqueueCandidates([id]);
    const batch = currentRun().batches[0];
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map([[id, relevance]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate(id), relevance }]);
    mockFetchResults.mockResolvedValueOnce({
      requestId: batch.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    await handlePush(batch.requestId, 'foreground');
    return { relevanceBatch: batch, reasonsBatch: currentRun().batches[0] };
  }

  it('DEFAULT (off): no marker on the batch, legacy reason prompt, prose decoder', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(false));
    const { reasonsBatch } = await legacyToReasonPhase('a0', 0.8);

    // Absent, not `false` — a legacy run written before this field existed must
    // parse and resume identically, which is what makes the default inert.
    expect(reasonsBatch.noteMode).toBeUndefined();
    expect(mockBuildReasonCallsForSubset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      expect.objectContaining({ legacyNoteDemote: false }),
    );

    // Prose decoder: the plain reason is saved verbatim, and nothing is demoted.
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(),
      reasonMap: new Map([['a0', 'because it matters']]),
      failedIds: new Set(),
      rescoreMap: new Map(),
    });
    mockSaveScoringResult.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [{ id: 'reason:a0', ok: true }],
    });
    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'because it matters');
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
  });

  it('ON: the marker is persisted at submit and the note prompt is requested', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(true));
    const { reasonsBatch } = await legacyToReasonPhase('a0', 0.8);

    expect(reasonsBatch.noteMode).toBe(true);
    // No v3 marker — this is the LEGACY path wearing the note pass. Nothing
    // writes `v3Mode` any more; it exists only to be detected and cleared.
    expect(reasonsBatch.v3Mode).toBeUndefined();
    expect(mockBuildReasonCallsForSubset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({ legacyNoteDemote: true }),
    );
  });

  it('ON: a kept row gets its sentence; the prose decoder is never consulted', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(true));
    const { reasonsBatch } = await legacyToReasonPhase('a0', 0.8);
    mockDecodeResults.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [
        { id: 'reason:a0', ok: true, output: '{"keep":true,"why":"Your Bhopal family is in the flood zone."}' },
      ],
    });

    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'Your Bhopal family is in the flood zone.');
    // decodeResults is the PROSE reader; handing it `{"keep":…}` would persist
    // raw JSON as the user-facing note.
    expect(mockDecodeResults).not.toHaveBeenCalled();
  });

  it('ON: a rejected row is demoted below the gate, terminal and noteless', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(true));
    const { reasonsBatch } = await legacyToReasonPhase('a0', 0.8);
    mockSaveReason.mockClear();
    mockSaveScoringResult.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [{ id: 'reason:a0', ok: true, output: '{"keep":false}' }],
    });

    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).toHaveBeenCalledWith('a0', {
      relevance: DEFAULT_HARNESS_CONFIG.articlePipeline.feedVerifierDemoteScore,
      reason: '',
      reasonSkipped: true,
    });
  });

  it('ON: fails OPEN on an unusable verdict — score stands, note still owed', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(true));
    const { reasonsBatch } = await legacyToReasonPhase('a0', 0.8);
    mockSaveReason.mockClear();
    mockSaveScoringResult.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [{ id: 'reason:a0', ok: true, output: 'I am not JSON' }],
    });

    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).not.toHaveBeenCalled();
    expect(mockSaveScoringResult).not.toHaveBeenCalled();
  });

  // The whole reason the marker is persisted rather than re-read at decode.
  it('an in-flight batch keeps its own contract when the live flag flips', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(true));
    const { reasonsBatch } = await legacyToReasonPhase('a0', 0.8);
    expect(reasonsBatch.noteMode).toBe(true);

    // OTA lands mid-flight and turns the flag back off.
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(false));
    mockDecodeResults.mockClear();
    mockFetchResults.mockResolvedValueOnce({
      requestId: reasonsBatch.requestId,
      results: [{ id: 'reason:a0', ok: true, output: '{"keep":true,"why":"Still decoded as a verdict."}' }],
    });

    await handlePush(reasonsBatch.requestId, 'foreground');

    expect(mockSaveReason).toHaveBeenCalledWith('a0', 'Still decoded as a verdict.');
    expect(mockDecodeResults).not.toHaveBeenCalled();
  });
});

// The orphaned-reason sweep is a SECOND submit path, and it reads the flag from
// its own call site. An earlier cut of this wiring read the raw
// DEFAULT_HARNESS_CONFIG literal there while the relevance path read the
// calibrated `effectiveHarnessConfig` — invisible today (both resolve to the
// same literal), and a silent split the moment the flag is layered at runtime,
// which is exactly how the v4 article-tag flags are bound. This pins that both paths ask the
// same question of the same object.
describe('legacyNoteDemote — the orphaned-reason sweep reads the same config', () => {
  const noteConfig = (on: boolean) => ({
    ...DEFAULT_HARNESS_CONFIG,
    articlePipeline: {
      ...DEFAULT_HARNESS_CONFIG.articlePipeline,
      legacyNoteDemote: on,
    },
  });

  it('OFF: reasonsOnly batches carry no marker and request the legacy prompt', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(false));
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('o0'), relevance: 0.8 }]);

    await enqueueOrphanedReasons();

    expect(mockBuildReasonCallsForSubset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      expect.objectContaining({ legacyNoteDemote: false }),
    );
    expect(currentRun().batches[0].noteMode).toBeUndefined();
  });

  it('ON: reasonsOnly batches request the note prompt AND persist the marker', async () => {
    mockEffectiveHarnessConfig.mockResolvedValue(noteConfig(true));
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('o0'), relevance: 0.8 }]);

    await enqueueOrphanedReasons();

    expect(mockBuildReasonCallsForSubset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({ legacyNoteDemote: true }),
    );
    // Persisted, not re-derived: this batch's results must decode as verdicts
    // even if an OTA turns the flag off while it is in flight.
    expect(currentRun().batches[0].noteMode).toBe(true);
  });
});

describe('derivePipelineChunkStates', () => {
  // The bucketing table, all eight BatchPhase values, so a phase added later
  // fails here rather than silently rendering as `in-flight`.
  it('buckets every phase', () => {
    const run = makeRun([
      { phase: 'queued', candidateIds: ['a'] },
      { phase: 'submitting-relevance', candidateIds: ['b'] },
      { phase: 'waiting-relevance', candidateIds: ['c'] },
      { phase: 'needs-reasons-submit', candidateIds: ['d'] },
      { phase: 'submitting-reasons', candidateIds: ['e'] },
      { phase: 'waiting-reasons', candidateIds: ['f'] },
      { phase: 'done', candidateIds: ['g'] },
      { phase: 'failed', candidateIds: ['h'] },
    ]);
    expect(derivePipelineChunkStates(run).chunks).toEqual([
      'queued',
      'in-flight',
      'in-flight',
      'in-flight',
      'in-flight',
      'in-flight',
      'ready',
      'failed',
    ]);
  });

  it('keeps run.batches order, so a failed chunk sits behind ready ones', () => {
    const states = derivePipelineChunkStates(
      makeRun([
        { phase: 'done', candidateIds: ['a'] },
        { phase: 'failed', candidateIds: ['b'] },
        { phase: 'done', candidateIds: ['c'] },
        { phase: 'waiting-relevance', candidateIds: ['d'] },
      ]),
    );
    expect(states.chunks).toEqual(['ready', 'failed', 'ready', 'in-flight']);
    expect(states.ready).toBe(2);
    expect(states.total).toBe(4);
  });

  it('reports nothing once every batch is terminal, so no stale strip survives', () => {
    // Same idle rule as derivePipelineBatchProgress: one definition of idle
    // across the three projections, not three kept in lockstep by hand.
    expect(
      derivePipelineChunkStates(
        makeRun([
          { phase: 'done', candidateIds: ['a'] },
          { phase: 'failed', candidateIds: ['b'] },
        ]),
      ),
    ).toEqual({ chunks: [], ready: 0, total: 0 });
  });

  it('counts BATCHES, which is not derivePipelineBatchProgress\'s article count', () => {
    // Both are true at the same instant and neither is the other\'s percentage.
    // Presenting one as the other is the trap this pins.
    const run = makeRun([
      { phase: 'done', candidateIds: ['a', 'b', 'c'] },
      { phase: 'waiting-relevance', candidateIds: ['d', 'e'] },
    ]);
    expect(derivePipelineChunkStates(run)).toEqual({
      chunks: ['ready', 'in-flight'],
      ready: 1,
      total: 2,
    });
    expect(derivePipelineBatchProgress(run)).toEqual({ done: 3, total: 5 });
  });

  it('grows rather than resets when the gate elects more batches mid-run', () => {
    // The gate re-elects held-back duplicate siblings into new batches, so
    // `total` is not fixed when the strip first renders.
    expect(
      derivePipelineChunkStates(makeRun([{ phase: 'waiting-relevance', candidateIds: ['a'] }]))
        .total,
    ).toBe(1);
    expect(
      derivePipelineChunkStates(
        makeRun([
          { phase: 'waiting-relevance', candidateIds: ['a'] },
          { phase: 'queued', candidateIds: ['b'] },
          { phase: 'queued', candidateIds: ['c'] },
        ]),
      ).total,
    ).toBe(3);
  });

  it('reports an empty run as idle rather than as a zero-length strip', () => {
    expect(derivePipelineChunkStates(makeRun([]))).toEqual({
      chunks: [],
      ready: 0,
      total: 0,
    });
  });
});


// ---------------------------------------------------------------------------
// bgsubmit: idempotency keys, staleness, and the background task entry points
// ---------------------------------------------------------------------------

const DEADLINE_MS = 60_000;
const relevanceReady = (requestId: string) => ({
  requestId,
  results: [{ id: 'score:0', ok: true }],
});

describe('idempotency key', () => {
  it('sends a key minted at submit: runId, batchId, phase, generation 0', async () => {
    await enqueueCandidates(['a0']);
    const run = currentRun();
    const call = mockSendInferenceRequest.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(`${run.runId}:0:rel:0`);
    expect(run.batches[0].idemKey).toBe(`${run.runId}:0:rel:0`);
    expect(run.batches[0].sentIds).toEqual(['a0']);
  });

  it('resends the SAME key after a failed POST for the same ids', async () => {
    // The drain re-admits the requeued batch at once (the limiter mock always
    // grants), so the retry is the second call.
    mockSendInferenceRequest.mockResolvedValueOnce({ status: 'failed' });
    await enqueueCandidates(['a0']);
    const first = mockSendInferenceRequest.mock.calls[0][0].idempotencyKey;
    const second = mockSendInferenceRequest.mock.calls[1][0].idempotencyKey;
    expect(second).toBe(first);
    expect(currentRun().batches[0].attempt).toBe(1);
  });

  it('mints a new generation when the ids to send changed', async () => {
    let calls = 0;
    mockSendInferenceRequest.mockImplementation(async () => {
      calls += 1;
      // a1 got scored elsewhere after the first attempt: the rebuilt bundle
      // for the retry carries only a0.
      if (calls === 1) {
        mockGetUnscored.mockImplementation(async () => [candidate('a0')]);
        return { status: 'failed' };
      }
      return { status: 'ok', requestId: 'req-x', capabilityToken: 'cap-x' };
    });
    await enqueueCandidates(['a0', 'a1']);
    const first = mockSendInferenceRequest.mock.calls[0][0].idempotencyKey as string;
    const second = mockSendInferenceRequest.mock.calls[1][0].idempotencyKey as string;
    expect(second).not.toBe(first);
    expect(second.endsWith(':rel:1')).toBe(true);
    expect(currentRun().batches[0].sentIds).toEqual(['a0']);
  });

  it('forgets the key when a waiting batch is requeued off a 404', async () => {
    await enqueueCandidates(['a0']);
    const first = mockSendInferenceRequest.mock.calls[0][0].idempotencyKey as string;
    mockFetchResults.mockResolvedValueOnce('not-found');

    await pollTick('foreground');

    const resent = mockSendInferenceRequest.mock.calls[1][0].idempotencyKey as string;
    expect(resent).not.toBe(first);
    expect(resent.endsWith(':rel:1')).toBe(true);
  });

  it('treats 409 as in progress: requeued with attempt and key unchanged', async () => {
    mockSendInferenceRequest.mockResolvedValueOnce({ status: 'in-progress' });
    await enqueueCandidates(['a0']);
    const b = currentRun().batches[0];
    expect(b.attempt).toBe(0);
    const keys = mockSendInferenceRequest.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(b.idemKey).toBe(keys[0]);
  });
});

describe('staleness counts from the first check, not the submit', () => {
  it('a batch submitted 6h ago is not requeued on its first slow poll after open', async () => {
    await enqueueCandidates(['a0']);
    mockRun.batches[0].submittedAt = NOW - 6 * 3600_000;
    mockFetchResults.mockResolvedValue('pending');
    mockSendInferenceRequest.mockClear();

    await pollTick('foreground');

    const b = currentRun().batches[0];
    expect(b.phase).toBe('waiting-relevance');
    expect(b.attempt).toBe(0);
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('passes submittedAt so an expired capability token is not offered', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockResolvedValue('pending');
    await pollTick('foreground');
    const opts = mockFetchResults.mock.calls[0][3];
    expect(opts.submittedAt).toBe(currentRun().batches[0].submittedAt);
  });
});

describe('staleRunVerdict', () => {
  const run = (over: Partial<PipelineRun>, batches: any[]): PipelineRun =>
    ({ schema: 3, runId: 'r', startedAt: NOW, algo: 'ed25519', expoPushToken: null, version: 1, batches, ...over }) as PipelineRun;

  it('is none with no run', async () => {
    expect(await staleRunVerdict(NOW)).toBe('none');
  });

  it('is fresh while the run moved within the guard window', () => {
    const r = run({ startedAt: NOW - 3600_000 }, [
      { batchId: 0, phase: 'waiting-relevance', candidateIds: ['a'], attempt: 0, submittedAt: NOW - 60_000 },
    ]);
    expect(deriveStaleRunVerdict(r, NOW)).toBe('fresh');
  });

  it('is collectable when quiet but a batch was submitted within the collect window', () => {
    const r = run({ startedAt: NOW - 8 * 3600_000 }, [
      { batchId: 0, phase: 'waiting-relevance', candidateIds: ['a'], attempt: 0, submittedAt: NOW - 6 * 3600_000 },
    ]);
    expect(deriveStaleRunVerdict(r, NOW)).toBe('collectable');
  });

  it('counts a needs-reasons-submit batch as collectable too', () => {
    const r = run({ startedAt: NOW - 8 * 3600_000 }, [
      { batchId: 0, phase: 'needs-reasons-submit', candidateIds: ['a'], attempt: 0, submittedAt: NOW - 6 * 3600_000 },
    ]);
    expect(deriveStaleRunVerdict(r, NOW)).toBe('collectable');
  });

  it('is wedged past the collect window, or with nothing waiting', () => {
    const old = run({ startedAt: NOW - COLLECT_WINDOW_MS - 7200_000 }, [
      { batchId: 0, phase: 'waiting-relevance', candidateIds: ['a'], attempt: 0, submittedAt: NOW - COLLECT_WINDOW_MS - 3600_000 },
    ]);
    expect(deriveStaleRunVerdict(old, NOW)).toBe('wedged');
    const stuck = run({ startedAt: NOW - 3600_000 }, [
      { batchId: 0, phase: 'queued', candidateIds: ['a'], attempt: 0 },
    ]);
    expect(deriveStaleRunVerdict(stuck, NOW)).toBe('wedged');
  });
});

describe('reasons in flight', () => {
  it('covers reason candidates, their covered siblings and reasons-only batches; nothing terminal', () => {
    const r = {
      schema: 3, runId: 'r', startedAt: NOW, algo: 'ed25519', expoPushToken: null, version: 1,
      batches: [
        { batchId: 0, phase: 'waiting-reasons', candidateIds: ['a', 'b'], reasonCandidateIds: ['a'], coveredByRep: { a: ['a2'] }, attempt: 0 },
        { batchId: 1, phase: 'waiting-relevance', candidateIds: ['c'], attempt: 0 },
        { batchId: 2, phase: 'queued', reasonsOnly: true, candidateIds: ['d'], attempt: 0 },
        { batchId: 3, phase: 'done', candidateIds: ['e'], reasonCandidateIds: ['e'], attempt: 0 },
      ],
    } as unknown as PipelineRun;
    expect([...deriveReasonsInFlightIds(r)].sort()).toEqual(['a', 'a2', 'd']);
  });

  it('publishes a NEW Set on every UI push', async () => {
    await enqueueCandidates(['a0']);
    const sets = mockSetReasonsInFlightIds.mock.calls.map((c) => c[0]);
    expect(sets.length).toBeGreaterThan(0);
    expect(sets[0]).toBeInstanceOf(Set);
    expect(await getReasonsInFlightIds()).toBeInstanceOf(Set);
  });

  it('copies a rep note onto its reason_pending covered sibling when reasons apply', async () => {
    mockGateUnscoredForScoring.mockImplementationOnce(async () => ({
      propagatedCount: 0,
      heldBackCount: 1,
      enqueueIds: ['a0'],
      coveredIdsByRep: { a0: ['a0', 'a0-dup'] },
      readCount: 2,
    }));
    mockGetUnscored.mockImplementation(async () => [candidate('a0')]);
    await enqueueUnscoredEligible({ flushRemainder: true });
    const batch = currentRun().batches[0];
    expect(batch.coveredByRep).toEqual({ a0: ['a0-dup'] });

    // relevance lands → reasons submitted
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValueOnce(relevanceReady(batch.requestId));
    await pollTick('foreground');
    expect(currentRun().batches[0].phase).toBe('waiting-reasons');
    expect(await getReasonsInFlightIds()).toEqual(new Set(['a0', 'a0-dup']));

    // reasons land → sibling gets the note
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(),
      reasonMap: new Map([['a0', 'Why it matters.']]),
      failedIds: new Set(),
    });
    mockGetGroupingRowsByIds.mockResolvedValueOnce([
      { id: 'a0-dup', status: 'reason_pending', relevance: 0.8, scoredWithV3: null },
    ]);
    mockFetchResults.mockResolvedValueOnce({ requestId: 'x', results: [{ id: 'reason:a0', ok: true }] });
    jest.setSystemTime(NOW + 10_000);
    await pollTick('foreground');

    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'a0-dup', relevance: 0.8, reason: 'Why it matters.', scoredWithV3: null },
    ]);
  });
});

describe('advanceWaitingForBackground (step a)', () => {
  it('reports no-run when there is nothing to collect', async () => {
    const out = await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });
    expect(out.stoppedBy).toBe('no-run');
  });

  /** Three waiting-relevance batches, every one ready on the gateway, every
   *  candidate impactful. `decodeDelayMs` advances the clock inside each
   *  decrypt, standing in for slow pure-JS decryption. */
  async function threeReadyBatches(decodeDelayMs = 0): Promise<any[]> {
    await enqueueCandidates(ids(5 + 10 + 25)); // three ramped batches
    const batches = currentRun().batches.map((b: any) => ({ ...b }));
    expect(batches.map((b: any) => b.phase)).toEqual([
      'waiting-relevance',
      'waiting-relevance',
      'waiting-relevance',
    ]);
    const all: string[] = batches.flatMap((b: any) => b.candidateIds);
    mockDecodeResults.mockImplementation(() => {
      if (decodeDelayMs > 0) jest.setSystemTime(Date.now() + decodeDelayMs);
      return { scoreMap: new Map(all.map((id) => [id, 0.8])), reasonMap: new Map(), failedIds: new Set() };
    });
    mockGetScoredWithoutReasons.mockResolvedValue(all.map((id) => ({ ...candidate(id), relevance: 0.8 })));
    mockFetchResults.mockImplementation(async (requestId: string) => relevanceReady(requestId));
    mockSendInferenceRequest.mockClear();
    return batches;
  }

  it('collects every ready relevance batch and submits each one\'s reasons, in task context', async () => {
    await threeReadyBatches();

    const out = await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });

    expect(out).toEqual(
      expect.objectContaining({ appliedRelevance: 3, reasonsSubmitted: 3, stoppedBy: 'done' }),
    );
    expect(mockFetchResults).toHaveBeenCalledTimes(3);
    expect(mockFetchResults.mock.calls.every((c) => c[1] === 'task')).toBe(true);
    expect(currentRun().batches.map((b: any) => b.phase)).toEqual([
      'waiting-reasons',
      'waiting-reasons',
      'waiting-reasons',
    ]);
    const send = mockSendInferenceRequest.mock.calls[0][0];
    expect(send).toEqual(expect.objectContaining({ context: 'task', singleAttempt: true }));
    expect(send.idempotencyKey).toMatch(/:0:r:\d+$/);
  });

  it('stops cleanly once the collect floor is reached; later batches stay exactly as they were', async () => {
    // The first decrypt eats 35s of a 60s window: 25s left is under the 30s floor.
    const before = await threeReadyBatches(35_000);

    const out = await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });

    expect(out).toEqual(
      expect.objectContaining({ appliedRelevance: 1, reasonsSubmitted: 1, stoppedBy: 'deadline' }),
    );
    expect(mockFetchResults).toHaveBeenCalledTimes(1);
    const run = currentRun();
    expect(run.batches[0].phase).toBe('waiting-reasons');
    for (const i of [1, 2]) {
      expect(run.batches[i]).toEqual(before[i]);
    }
  });

  it('respects the 30s floor when decryption is slow', async () => {
    // 20s per decrypt: 60s left → apply (40s left) → apply (20s left) → stop.
    await threeReadyBatches(20_000);

    const out = await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });

    expect(out.appliedRelevance).toBe(2);
    expect(out.reasonsSubmitted).toBe(2);
    expect(out.stoppedBy).toBe('deadline');
    expect(currentRun().batches.map((b: any) => b.phase)).toEqual([
      'waiting-reasons',
      'waiting-reasons',
      'waiting-relevance',
    ]);
  });

  it('never requeues on pending, even hours after submit', async () => {
    await enqueueCandidates(['a0']);
    mockRun.batches[0].submittedAt = NOW - 6 * 3600_000;
    mockFetchResults.mockResolvedValue('pending');
    mockSendInferenceRequest.mockClear();

    await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });

    expect(currentRun().batches[0].phase).toBe('waiting-relevance');
    expect(currentRun().batches[0].attempt).toBe(0);
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('requeues on a definite 404 but does not resubmit or drain from the task', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockResolvedValue('not-found');
    mockSendInferenceRequest.mockClear();

    await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });

    expect(currentRun().batches[0].phase).toBe('queued');
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });

  it('stops quietly on no-auth and leaves the batch waiting', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockResolvedValue('unauthorized');
    const out = await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });
    expect(out.stoppedBy).toBe('no-auth');
    expect(currentRun().batches[0].phase).toBe('waiting-relevance');
  });

  it('starts nothing when the deadline is inside the POST reserve', async () => {
    await enqueueCandidates(['a0']);
    mockFetchResults.mockClear();
    const out = await advanceWaitingForBackground({ deadlineAt: NOW + 5_000 });
    expect(out.stoppedBy).toBe('deadline');
    expect(mockFetchResults).not.toHaveBeenCalled();
  });

  it('task context does not leak into a concurrent foreground recover()', async () => {
    await enqueueCandidates(['a0']);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockFetchResults.mockImplementationOnce(async () => {
      await gate;
      return 'pending';
    });
    mockFetchResults.mockResolvedValue('pending');

    const task = advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });
    await Promise.resolve();
    const fg = recover();
    release();
    await task;
    await fg;

    const contexts = mockFetchResults.mock.calls.map((c) => c[1]);
    expect(contexts[0]).toBe('task');
    expect(contexts.slice(1).every((c) => c === 'foreground')).toBe(true);
  });
});

describe('submitScoringForBackground (step b)', () => {
  it('does nothing in on-device mode', async () => {
    mockProcessingMode = 'ON_DEVICE';
    try {
      const out = await submitScoringForBackground({ deadlineAt: NOW + DEADLINE_MS, articleIds: ['a0'] });
      expect(out).toEqual({ submitted: 0, stoppedBy: 'on-device' });
    } finally {
      mockProcessingMode = 'CLOUD';
    }
  });

  it('batches the new rows and submits in task context, single attempt, keyed', async () => {
    mockGetUnscored.mockImplementation(async () => [candidate('n0'), candidate('n1')]);
    const out = await submitScoringForBackground({ deadlineAt: NOW + DEADLINE_MS, articleIds: ['n0', 'n1'] });

    expect(out).toEqual({ submitted: 1, stoppedBy: 'done' });
    const send = mockSendInferenceRequest.mock.calls[0][0];
    expect(send).toEqual(expect.objectContaining({ context: 'task', singleAttempt: true, grantAlreadyHeld: true }));
    expect(send.idempotencyKey).toMatch(/:0:rel:0$/);
    expect(currentRun().batches[0].phase).toBe('waiting-relevance');
  });

  it('respects maxBatches and leaves the rest queued for the foreground', async () => {
    const many = ids(5 + 10 + 25, 'm'); // three ramped batches
    mockGetUnscored.mockImplementation(async () => many.map(candidate));
    const out = await submitScoringForBackground({ deadlineAt: NOW + DEADLINE_MS, articleIds: many, maxBatches: 1 });
    expect(out.submitted).toBe(1);
    const phases = currentRun().batches.map((b: any) => b.phase);
    expect(phases.filter((p: string) => p === 'queued')).toHaveLength(2);
  });

  it('stops at the first no-auth and hands the batch back untouched', async () => {
    mockGetUnscored.mockImplementation(async () => [candidate('n0')]);
    mockSendInferenceRequest.mockResolvedValueOnce({ status: 'no-auth' });
    const out = await submitScoringForBackground({ deadlineAt: NOW + DEADLINE_MS, articleIds: ['n0'] });
    expect(out.stoppedBy).toBe('no-auth');
    const b = currentRun().batches[0];
    expect(b.phase).toBe('queued');
    expect(b.attempt).toBe(0);
  });

  it('submits nothing inside the POST reserve', async () => {
    mockGetUnscored.mockImplementation(async () => [candidate('n0')]);
    const out = await submitScoringForBackground({ deadlineAt: NOW + 10_000, articleIds: ['n0'] });
    expect(out.stoppedBy).toBe('deadline');
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
  });
});

describe('task context skips UI work while the app is not active', () => {
  it('step (a) in background applies results without refreshing the store or pushing progress', async () => {
    await enqueueCandidates(['a0']);
    const b0 = currentRun().batches[0];
    mockAppStateCurrent = 'background';
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValue(relevanceReady(b0.requestId));
    mockRefresh.mockClear();
    mockSetReasonsInFlightIds.mockClear();
    mockSetAsyncJobPhase.mockClear();

    const out = await advanceWaitingForBackground({ deadlineAt: NOW + DEADLINE_MS });

    expect(out.appliedRelevance).toBe(1);
    expect(mockSaveScoringResult).toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockSetReasonsInFlightIds).not.toHaveBeenCalled();
    expect(mockSetAsyncJobPhase).not.toHaveBeenCalled();
  });

  it('step (b) in background submits without refreshing the store or pushing progress', async () => {
    mockAppStateCurrent = 'background';
    mockGetUnscored.mockImplementation(async () => [candidate('n0')]);
    mockRefresh.mockClear();
    mockSetReasonsInFlightIds.mockClear();
    mockSetAsyncJobPhase.mockClear();

    const out = await submitScoringForBackground({ deadlineAt: NOW + DEADLINE_MS, articleIds: ['n0'] });

    expect(out.submitted).toBe(1);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockSetReasonsInFlightIds).not.toHaveBeenCalled();
    expect(mockSetAsyncJobPhase).not.toHaveBeenCalled();
  });

  it('the silent-push wake (background context) still refreshes as before', async () => {
    await enqueueCandidates(['a0']);
    const b0 = currentRun().batches[0];
    mockAppStateCurrent = 'background';
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map([['a0', 0.8]]),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue([{ ...candidate('a0'), relevance: 0.8 }]);
    mockFetchResults.mockResolvedValue(relevanceReady(b0.requestId));
    mockRefresh.mockClear();

    await handlePush(b0.requestId, 'background');

    expect(mockRefresh).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rank-ordered gateway scheduling: every slot goes to the lowest batchId with
// something to do, whatever kind of action that is.
// ---------------------------------------------------------------------------

describe('pickNextGatewayAction', () => {
  const b = (batchId: number, phase: string, extra: Record<string, unknown> = {}): any => ({
    batchId,
    phase,
    candidateIds: [],
    attempt: 0,
    requestId: `req-${batchId}`,
    submittedAt: NOW - 60_000,
    ...extra,
  });
  const pick = (batches: any[], opts: Record<string, unknown> = {}) =>
    pickNextGatewayAction(batches, {
      now: NOW,
      lastPolledAt: new Map(),
      allowFreshSubmit: true,
      ...opts,
    });

  it('an earlier batch\'s notes submit beats a later batch\'s relevance submit', () => {
    expect(pick([b(4, 'queued'), b(1, 'needs-reasons-submit')])).toEqual({
      kind: 'submit-reasons',
      batchId: 1,
    });
  });

  it('polls by rank, not by submit time: batch 1 before batch 3 even when submitted later', () => {
    const batches = [
      b(3, 'waiting-relevance', { submittedAt: NOW - 30_000 }),
      b(1, 'waiting-reasons', { submittedAt: NOW - 5_000 }),
    ];
    expect(pick(batches)).toEqual({ kind: 'poll', batchId: 1 });
  });

  it('notes jobs do not hold a relevance slot; the total cap still binds', () => {
    const relevanceFull = [
      b(0, 'waiting-reasons'),
      b(1, 'waiting-relevance'),
      b(2, 'waiting-relevance'),
      b(3, 'queued'),
    ];
    // Three outstanding jobs, but only two are relevance: batch 3 may submit
    // once the polls are out of the way.
    const spaced = new Map([0, 1, 2].map((id) => [id, NOW]));
    expect(pick(relevanceFull, { lastPolledAt: spaced })).toEqual({ kind: 'submit', batchId: 3 });

    const threeRelevance = [...relevanceFull.slice(1), b(4, 'waiting-relevance'), b(5, 'queued')];
    const spaced2 = new Map([1, 2, 4].map((id) => [id, NOW]));
    expect(pick(threeRelevance, { lastPolledAt: spaced2 })).toBeNull();
    expect(MAX_IN_FLIGHT).toBe(3);

    const totalFull = Array.from({ length: MAX_IN_FLIGHT_TOTAL }, (_, i) => b(i, 'waiting-reasons'));
    const spaced3 = new Map(totalFull.map((x: any) => [x.batchId, NOW]));
    expect(pick([...totalFull, b(9, 'queued', { reasonsOnly: true })], { lastPolledAt: spaced3 })).toBeNull();
  });

  it('caps never hold back a notes submit or a poll', () => {
    const full = Array.from({ length: MAX_IN_FLIGHT_TOTAL }, (_, i) => b(i + 1, 'waiting-relevance'));
    expect(pick([...full, b(0, 'needs-reasons-submit')])).toEqual({ kind: 'submit-reasons', batchId: 0 });
    expect(pick(full)).toEqual({ kind: 'poll', batchId: 1 });
  });

  it('returns nothing while every poll is inside its spacing', () => {
    const batches = [b(0, 'waiting-relevance'), b(1, 'waiting-reasons')];
    expect(pick(batches, { lastPolledAt: new Map([[0, NOW], [1, NOW]]) })).toBeNull();
  });

  it('backs a pending job off (x2, x4) so later batches still get submitted', () => {
    const batches = [b(0, 'waiting-relevance'), b(1, 'queued')];
    // Poll spacing is the mocked 1000ms limiter interval less the 250ms lead.
    const polled = new Map([[0, NOW - 1_000]]); // past one spacing (750), inside two (1500)
    const once = new Map([[pendingPollKey(batches[0]), 1]]);
    expect(pick(batches, { lastPolledAt: polled })).toEqual({ kind: 'poll', batchId: 0 });
    expect(pick(batches, { lastPolledAt: polled, pendingPolls: once })).toEqual({
      kind: 'submit',
      batchId: 1,
    });
  });

  it('backoff never leaves a slot idle: with nothing else to do, the backed-off job is polled', () => {
    const only = [b(0, 'waiting-relevance')];
    const polled = new Map([[0, NOW - 1_000]]); // past plain spacing, inside x4
    const twice = new Map([[pendingPollKey(only[0]), 2]]);
    expect(pick(only, { lastPolledAt: polled, pendingPolls: twice })).toEqual({ kind: 'poll', batchId: 0 });
  });

  it('a background wake never admits a fresh submit', () => {
    expect(pick([b(0, 'queued')], { allowFreshSubmit: false })).toBeNull();
  });


});

describe('notes do not hold a relevance slot (end to end)', () => {
  it('a fourth relevance batch submits while batch 0 is writing its notes', async () => {
    await enqueueCandidates(ids(5 + 10 + 25 + 50)); // 4 ramped batches
    expect(currentRun().batches.map((x: any) => x.phase)).toEqual([
      'waiting-relevance',
      'waiting-relevance',
      'waiting-relevance',
      'queued',
    ]);

    const batch0 = currentRun().batches[0];
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(batch0.candidateIds.map((id: string) => [id, 0.8])),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockGetScoredWithoutReasons.mockResolvedValue(
      batch0.candidateIds.map((id: string) => ({ ...candidate(id), relevance: 0.8 })),
    );
    mockFetchResults.mockImplementation(async (requestId: string) =>
      requestId === batch0.requestId ? relevanceReady(requestId) : 'pending',
    );

    jest.setSystemTime(NOW + 5_000);
    await pollTick('foreground');

    const phases = currentRun().batches.map((x: any) => x.phase);
    expect(phases[0]).toBe('waiting-reasons');
    expect(phases[3]).toBe('waiting-relevance');
  });
});

describe('the drain yields to an earlier batch (measured regression)', () => {
  // Hydration enqueues every few hundred ms and each enqueue drains. A drain
  // that only looked at fresh submits spent every slot on batches 1-3 while
  // batch 0's finished one-call job went unpolled for 11s.
  it('an enqueue still submits the next batch right after batch 0 (a 0s-old job is not worth a poll)', async () => {
    await enqueueCandidates(ids(5 + 10)); // batches 0 and 1 in one enqueue
    expect(currentRun().batches.map((x: any) => x.phase)).toEqual([
      'waiting-relevance',
      'waiting-relevance',
    ]);
  });

  it('an enqueue does not submit a later batch while batch 0 is due a poll', async () => {
    await enqueueCandidates(ids(5, 'a')); // batch 0
    const batch0 = currentRun().batches[0];
    expect(batch0.phase).toBe('waiting-relevance');
    mockFetchResults.mockResolvedValue('pending');
    mockSendInferenceRequest.mockClear();

    jest.setSystemTime(NOW + 3_000);
    await enqueueCandidates(ids(10, 'b')); // batch 1, enqueued once batch 0 is pollable

    expect(currentRun().batches[1].phase).toBe('queued');
    expect(mockSendInferenceRequest).not.toHaveBeenCalled();
    expect(mockFetchResults).not.toHaveBeenCalled();

    // The drain kicked a poll tick: batch 0 is polled FIRST, then batch 1 goes.
    await jest.advanceTimersByTimeAsync(0);
    expect(mockFetchResults).toHaveBeenCalledWith(batch0.requestId, 'foreground', expect.anything(), expect.anything());
    expect(currentRun().batches[1].phase).toBe('waiting-relevance');
    expect(mockFetchResults.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendInferenceRequest.mock.invocationCallOrder[0],
    );
  });
});
