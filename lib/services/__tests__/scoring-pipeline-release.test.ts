// scoring-pipeline-release.test.ts — Wave 8 swipe-deck chunk release queue.
//
// Two layers:
//  1. computeReleasableBatchIds — the PURE in-order ordering decision (the core
//     of the reorder buffer: releases only the contiguous-from-front eligible
//     prefix). No harness needed.
//  2. A focused integration proving registerChunkReleaseListener wiring:
//     out-of-order batch completion releases nothing until the front batch is
//     ready, then releases in batchId order. Reuses the scoring-pipeline.test
//     mock scaffolding so the module loads without native deps.

// ---- shared mock fns (mirrors scoring-pipeline.test.ts) ----
const mockTryTakeImmediate = jest.fn();
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
const mockBatchSaveComputedScores = jest.fn();
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
const mockRefresh = jest.fn();
const mockFetchResults = jest.fn();
const mockDiscardLowRelevance = jest.fn();
const mockToBatchResult = jest.fn((...args: any[]) => ({ id: args[0].id, output: 'out' }));
const mockReconstructLookups = jest.fn((..._args: any[]) => ({ chunkIdToCandidates: new Map() }));
const mockGetExpoPushToken = jest.fn(() => 'ExponentPushToken[test]');
const mockSetAsyncJobPhase = jest.fn();
const mockPropagateToUnscoredSiblings = jest.fn();

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
  pauseFor: jest.fn(),
  acquire: jest.fn().mockResolvedValue(undefined),
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
  batchSaveComputedScores: (...args: any[]) => mockBatchSaveComputedScores(...args),
}));

jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  computeMathStage: (...args: any[]) => mockComputeMathStage(...args),
}));

jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  bucketScores: (...args: any[]) => mockBucketScores(...args),
  buildRelevanceCalls: (...args: any[]) => mockBuildRelevanceCalls(...args),
  buildReasonCallsForSubset: (...args: any[]) => mockBuildReasonCallsForSubset(...args),
  decodeResults: (...args: any[]) => mockDecodeResults(...args),
  runFeedVerifierPass: jest.fn().mockResolvedValue(0),
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

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: () => ({ setAsyncJobPhase: mockSetAsyncJobPhase }),
  },
}));

jest.mock('@/lib/feed-grouping/score-propagation', () => ({
  propagateToUnscoredSiblings: (...args: any[]) => mockPropagateToUnscoredSiblings(...args),
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
  computeReleasableBatchIds,
  registerChunkReleaseListener,
  enqueueCandidates,
  handlePush,
  _resetForTests,
  MIN_RUN_CANDIDATES,
  type ReleasableBatchView,
} from '@/lib/services/scoring-pipeline';

// ---------------------------------------------------------------------------
// PURE ordering helper
// ---------------------------------------------------------------------------

function view(
  batchId: number,
  opts: Partial<Omit<ReleasableBatchView, 'batchId'>> = {},
): ReleasableBatchView {
  return {
    batchId,
    released: opts.released ?? false,
    scored: opts.scored ?? false,
    terminal: opts.terminal ?? false,
  };
}

describe('computeReleasableBatchIds (pure ordering)', () => {
  it('releases nothing when the front batch is not yet scored/terminal', () => {
    expect(
      computeReleasableBatchIds([view(0), view(1, { scored: true })]),
    ).toEqual([]);
  });

  it('releases only the contiguous scored prefix from the front', () => {
    // 0 scored, 1 scored, 2 NOT, 3 scored → only [0, 1]; 3 waits behind 2.
    expect(
      computeReleasableBatchIds([
        view(0, { scored: true }),
        view(1, { scored: true }),
        view(2),
        view(3, { scored: true }),
      ]),
    ).toEqual([0, 1]);
  });

  it('out-of-order finish: a later batch scoring first releases nothing', () => {
    expect(
      computeReleasableBatchIds([view(0), view(1, { scored: true })]),
    ).toEqual([]);
  });

  it('head advances: once the front batch scores, it plus the ready tail release', () => {
    expect(
      computeReleasableBatchIds([
        view(0, { scored: true }),
        view(1, { scored: true }),
      ]),
    ).toEqual([0, 1]);
  });

  it('skips already-released front batches and continues the walk', () => {
    // 0 released, 1 scored, 2 not, 3 scored → [1]; 3 still blocked by 2.
    expect(
      computeReleasableBatchIds([
        view(0, { released: true }),
        view(1, { scored: true }),
        view(2),
        view(3, { scored: true }),
      ]),
    ).toEqual([1]);
  });

  it('treats a terminal (done/failed) batch as releasable', () => {
    expect(
      computeReleasableBatchIds([
        view(0, { terminal: true }),
        view(1, { scored: true }),
        view(2),
      ]),
    ).toEqual([0, 1]);
  });

  it('sorts by batchId before walking (input order agnostic)', () => {
    expect(
      computeReleasableBatchIds([
        view(2, { scored: true }),
        view(0, { scored: true }),
        view(1, { scored: true }),
      ]),
    ).toEqual([0, 1, 2]);
  });

  it('is a no-op on an empty batch list', () => {
    expect(computeReleasableBatchIds([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Listener wiring + in-order release integration
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

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

function idRange(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `id${start + i}`);
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
  });
  mockRebuildE2EEContext.mockResolvedValue({
    privateKey: new Uint8Array([1, 2, 3, 4]),
    algo: 'ed25519',
    headers: {},
  });
  mockSendInferenceRequest.mockImplementation(async () => ({
    status: 'ok',
    requestId: `req-${reqCounter++}`,
    capabilityToken: `cap-${reqCounter}`,
  }));
  mockGetUnscored.mockImplementation(async () => {
    const all = new Set<string>();
    if (mockRun) {
      for (const b of mockRun.batches) for (const id of b.candidateIds) all.add(id);
    }
    return Array.from(all).map((id) => candidate(id));
  });
  mockCountUnscoredSuggestions.mockResolvedValue(MIN_RUN_CANDIDATES + 100);
  mockGetOldestUnscoredCreatedAt.mockResolvedValue(NOW);
  mockGetScoredWithoutReasons.mockResolvedValue([]);
  mockSaveScoringResult.mockResolvedValue(undefined);
  mockSaveReason.mockResolvedValue(undefined);
  mockBucketScores.mockImplementation(() => undefined);
  mockBuildRelevanceCalls.mockImplementation(async (subset: any[]) => ({
    calls: Array.from(
      { length: Math.max(1, Math.ceil(subset.length / 5)) },
      (_, i) => ({ id: `score:${i}`, system: 's', prompt: 'p' }),
    ),
    eligibleCandidates: subset,
    promptsById: new Map(),
    chunkIdToCandidates: new Map(),
  }));
  mockDiscardLowRelevance.mockResolvedValue(0);
  mockRefresh.mockResolvedValue(undefined);
  mockPropagateToUnscoredSiblings.mockResolvedValue(0);
});

afterEach(() => {
  _resetForTests();
  jest.useRealTimers();
});

describe('registerChunkReleaseListener', () => {
  it('returns an unsubscribe that removes the listener', () => {
    const fn = jest.fn();
    const unsub = registerChunkReleaseListener(fn);
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('does not emit / run release machinery when NO listener is registered', async () => {
    // Two batches, both go done sub-threshold — with no listener nothing should
    // be marked released and no timers should be pending.
    await enqueueCandidates(idRange(0, 50));
    const [b0, b1] = mockRun.batches;
    mockDecodeResults.mockReturnValue({
      scoreMap: new Map(b0.candidateIds.map((id: string) => [id, 0.1])),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValue({
      requestId: b0.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    await handlePush(b0.requestId, 'foreground');
    // No `released`/`scored` flag was ever written onto any batch — the release
    // machinery is fully gated behind a registered listener.
    if (mockRun) {
      for (const b of mockRun.batches) {
        expect(b.released).toBeUndefined();
        expect(b.scored).toBeUndefined();
      }
    }
    void b1;
  });

  it('releases contiguously in batchId order when batches finish out of order', async () => {
    const releases: string[][] = [];
    const unsub = registerChunkReleaseListener((ids) => releases.push(ids));

    await enqueueCandidates(idRange(0, 50)); // batch0 = id0..24, batch1 = id25..49
    const b0 = mockRun.batches[0];
    const b1 = mockRun.batches[1];
    const b0Ids: string[] = b0.candidateIds;
    const b1Ids: string[] = b1.candidateIds;

    // Complete batch 1 (the SECOND batch) FIRST — all sub-threshold → done.
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(b1Ids.map((id) => [id, 0.1])),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValueOnce({
      requestId: b1.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    await handlePush(b1.requestId, 'foreground');

    // Nothing released yet: batch 0 (the front) is still in flight.
    expect(releases).toHaveLength(0);

    // Now complete batch 0 → releases batch 0 THEN batch 1, in order.
    mockDecodeResults.mockReturnValueOnce({
      scoreMap: new Map(b0Ids.map((id) => [id, 0.1])),
      reasonMap: new Map(),
      failedIds: new Set(),
    });
    mockFetchResults.mockResolvedValueOnce({
      requestId: b0.requestId,
      results: [{ id: 'score:0', ok: true }],
    });
    await handlePush(b0.requestId, 'foreground');

    expect(releases).toHaveLength(2);
    expect(new Set(releases[0])).toEqual(new Set(b0Ids));
    expect(new Set(releases[1])).toEqual(new Set(b1Ids));

    unsub();
  });
});
