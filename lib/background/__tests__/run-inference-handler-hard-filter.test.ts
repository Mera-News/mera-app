// P9 regression — the OTHER propagation writer: `gateUnscoredForScoring`.
//
// The gate propagates a scored donor's relevance onto unscored siblings and
// marks them terminal `complete` before anything is enqueued, so those rows
// never meet the scoring stage's hard screen either. The gate reports only a
// COUNT (its result shape and 2-arg signature are pinned by contract), so its
// callers reconcile with the FULL sweep rather than a scoped id list — see the
// HARD FILTERS note in score-propagation.ts.
//
// Pre-fix this route propagated and refreshed the store with no screen at all,
// so `purgeHardFilteredSuggestions` was never called.

const mockHandlePush = jest.fn();
const mockRecover = jest.fn();
const mockGetPipelineStatus = jest.fn();
const mockEnqueueCandidates = jest.fn();
const mockEnqueueOrphanedReasons = jest.fn();
const mockPollTick = jest.fn();
const mockGetNonTerminalCandidateIds = jest.fn();
const mockGetUnscored = jest.fn();
const mockBuildRelevanceCalls = jest.fn();
const mockGateUnscoredForScoring = jest.fn();
const mockLoadUserGeoLanguageContext = jest.fn();
const mockRequestSuggestionsRefresh = jest.fn();
const mockContextForCycleReason = jest.fn();
const mockCaptureException = jest.fn();
const mockPurgeHardFiltered = jest.fn();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('@/lib/services/scoring-pipeline', () => ({
  handlePush: (...args: any[]) => mockHandlePush(...args),
  recover: (...args: any[]) => mockRecover(...args),
  getPipelineStatus: (...args: any[]) => mockGetPipelineStatus(...args),
  enqueueCandidates: (...args: any[]) => mockEnqueueCandidates(...args),
  enqueueOrphanedReasons: (...args: any[]) => mockEnqueueOrphanedReasons(...args),
  pollTick: (...args: any[]) => mockPollTick(...args),
  getNonTerminalCandidateIds: (...args: any[]) => mockGetNonTerminalCandidateIds(...args),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscored(...args),
}));
jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  buildRelevanceCalls: (...args: any[]) => mockBuildRelevanceCalls(...args),
}));
jest.mock('@/lib/feed-grouping/score-propagation', () => ({
  gateUnscoredForScoring: (...args: any[]) => mockGateUnscoredForScoring(...args),
}));
jest.mock('@/lib/user-context/user-geo-language-context', () => ({
  loadUserGeoLanguageContext: (...args: any[]) => mockLoadUserGeoLanguageContext(...args),
}));
jest.mock('@/lib/services/SuggestionSyncService', () => ({
  requestSuggestionsRefresh: (...args: any[]) => mockRequestSuggestionsRefresh(...args),
}));
jest.mock('@/lib/llm/execution-context', () => ({
  contextForCycleReason: (...args: any[]) => mockContextForCycleReason(...args),
}));
// The reconcile is reached through a lazy `require`, so mocking the module is
// enough — no static import exists to intercept.
jest.mock('@/lib/services/suppression-sweep', () => ({
  purgeHardFilteredSuggestions: (...args: any[]) => mockPurgeHardFiltered(...args),
}));

import { runBackgroundCycle } from '../run-inference-handler';

beforeEach(() => {
  jest.clearAllMocks();
  mockContextForCycleReason.mockReturnValue('foreground');
  mockGetPipelineStatus.mockResolvedValue('running');
  mockEnqueueCandidates.mockResolvedValue(undefined);
  mockEnqueueOrphanedReasons.mockResolvedValue(undefined);
  mockPollTick.mockResolvedValue(undefined);
  mockGetNonTerminalCandidateIds.mockResolvedValue(new Set());
  mockGetUnscored.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
  mockBuildRelevanceCalls.mockResolvedValue({
    calls: [],
    eligibleCandidates: [{ id: 'a' }, { id: 'b' }],
  });
  mockRequestSuggestionsRefresh.mockResolvedValue(undefined);
  mockLoadUserGeoLanguageContext.mockResolvedValue(null);
  mockPurgeHardFiltered.mockResolvedValue({
    excludedIds: [],
    valueById: new Map(),
    evictedFromFeed: 0,
  });
});

describe('runBackgroundCycle — scoring-pass propagation × hard filters (P9)', () => {
  it('screens propagated rows against the live hard filters BEFORE refreshing the store', async () => {
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a'],
      propagatedCount: 3, // three siblings inherited a donor's score
      heldBackCount: 0,
    });
    const order: string[] = [];
    mockPurgeHardFiltered.mockImplementation(async () => {
      order.push('purge');
      return { excludedIds: ['blocked'], valueById: new Map(), evictedFromFeed: 1 };
    });
    mockRequestSuggestionsRefresh.mockImplementation(async () => {
      order.push('refresh');
    });

    await runBackgroundCycle('scoring-pass');

    expect(mockPurgeHardFiltered).toHaveBeenCalledTimes(1);
    // Order matters: a blocked card must never reach the feed, even for a frame.
    expect(order).toEqual(['purge', 'refresh']);
  });

  it('does not sweep when the gate propagated nothing', async () => {
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a', 'b'],
      propagatedCount: 0,
      heldBackCount: 0,
    });

    await runBackgroundCycle('scoring-pass');

    expect(mockPurgeHardFiltered).not.toHaveBeenCalled();
    expect(mockRequestSuggestionsRefresh).not.toHaveBeenCalled();
  });

  it('a sweep failure is reported but never fails the cycle', async () => {
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a'],
      propagatedCount: 2,
      heldBackCount: 0,
    });
    mockPurgeHardFiltered.mockRejectedValue(new Error('sweep boom'));

    await expect(runBackgroundCycle('scoring-pass')).resolves.toBe('running');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: 'reconcile-hard-filters' }),
      }),
    );
    // The store refresh still happens — the propagation itself is committed.
    expect(mockRequestSuggestionsRefresh).toHaveBeenCalledTimes(1);
  });
});
