// run-inference-handler.test.ts — unit tests for the pipelined runBackgroundCycle

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
const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    warn: (...args: any[]) => mockWarn(...args),
    info: (...args: any[]) => mockInfo(...args),
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

import { runBackgroundCycle } from '../run-inference-handler';

function bundleWith(ids: string[]) {
  return { calls: [], eligibleCandidates: ids.map((id) => ({ id })) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockContextForCycleReason.mockImplementation((reason: string) =>
    reason === 'phase1-done' || reason === 'phase2-done' || reason === 'silent-push'
      ? 'background'
      : 'foreground',
  );
  mockHandlePush.mockResolvedValue(undefined);
  mockRecover.mockResolvedValue('running');
  mockGetPipelineStatus.mockResolvedValue('running');
  mockEnqueueCandidates.mockResolvedValue(undefined);
  mockEnqueueOrphanedReasons.mockResolvedValue(undefined);
  mockPollTick.mockResolvedValue(undefined);
  mockGetNonTerminalCandidateIds.mockResolvedValue(new Set());
  mockGetUnscored.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
  mockBuildRelevanceCalls.mockResolvedValue(bundleWith(['a', 'b']));
  // Default gate: elect every eligible id (no propagation / no election).
  mockGateUnscoredForScoring.mockImplementation(async () => ({
    enqueueIds: ['a', 'b'],
    propagatedCount: 0,
    heldBackCount: 0,
  }));
  mockRequestSuggestionsRefresh.mockResolvedValue(undefined);
  mockLoadUserGeoLanguageContext.mockResolvedValue(null);
});

describe('runBackgroundCycle — background completion pushes', () => {
  it.each(['phase1-done', 'phase2-done', 'silent-push'] as const)(
    'routes %s to handlePush with the requestId and background context',
    async (reason) => {
      mockGetPipelineStatus.mockResolvedValue('running');

      const result = await runBackgroundCycle(reason, 'req-xyz');

      expect(mockHandlePush).toHaveBeenCalledWith('req-xyz', 'background');
      expect(result).toBe('running');
      expect(mockEnqueueCandidates).not.toHaveBeenCalled();
      expect(mockRecover).not.toHaveBeenCalled();
    },
  );

  it('passes undefined requestId through to handlePush when absent', async () => {
    await runBackgroundCycle('silent-push');
    expect(mockHandlePush).toHaveBeenCalledWith(undefined, 'background');
  });

  it('returns idle when the pipeline reports idle after a push', async () => {
    mockGetPipelineStatus.mockResolvedValue('idle');
    const result = await runBackgroundCycle('phase1-done', 'req-1');
    expect(result).toBe('idle');
  });
});

describe('runBackgroundCycle — app-resume', () => {
  it('delegates to recover() and returns its value', async () => {
    mockRecover.mockResolvedValue('idle');
    const result = await runBackgroundCycle('app-resume');
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(result).toBe('idle');
    expect(mockHandlePush).not.toHaveBeenCalled();
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
  });
});

describe('runBackgroundCycle — scoring-pass', () => {
  it('routes eligible ids through the gate and enqueues only the intersection of gate.enqueueIds + eligible', async () => {
    mockGetUnscored.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mockBuildRelevanceCalls.mockResolvedValue(bundleWith(['a', 'c'])); // eligible = {a, c}
    mockGetNonTerminalCandidateIds.mockResolvedValue(new Set(['in-flight']));
    // Gate elects 'a' and a non-eligible 'z' — only the eligible intersection
    // ('a') is enqueued.
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a', 'z'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    mockGetPipelineStatus.mockResolvedValue('running');

    const result = await runBackgroundCycle('scoring-pass');

    // Gate was fed the pipeline's in-flight set plus the (fail-open null) user
    // geo/language context loaded for this pass.
    expect(mockGateUnscoredForScoring).toHaveBeenCalledWith(new Set(['in-flight']), null);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['a']);
    expect(mockEnqueueOrphanedReasons).toHaveBeenCalledTimes(1);
    expect(mockPollTick).toHaveBeenCalledWith('foreground');
    expect(result).toBe('running');
  });

  it('refreshes the store when the gate propagated scores', async () => {
    mockBuildRelevanceCalls.mockResolvedValue(bundleWith(['a']));
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: [],
      propagatedCount: 3,
      heldBackCount: 0,
    });
    mockGetPipelineStatus.mockResolvedValue('running');

    await runBackgroundCycle('scoring-pass');

    expect(mockRequestSuggestionsRefresh).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
  });

  it('skips the gate + enqueueCandidates when no eligible ids but still enqueues orphaned reasons', async () => {
    mockBuildRelevanceCalls.mockResolvedValue(bundleWith([]));
    mockGetPipelineStatus.mockResolvedValue('idle');

    const result = await runBackgroundCycle('scoring-pass');

    expect(mockGateUnscoredForScoring).not.toHaveBeenCalled();
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
    expect(mockEnqueueOrphanedReasons).toHaveBeenCalledTimes(1);
    expect(mockPollTick).toHaveBeenCalledWith('foreground');
    expect(result).toBe('idle');
  });
});

describe('runBackgroundCycle — error handling', () => {
  it('catches exceptions and returns error', async () => {
    const err = new Error('network failure');
    mockGetUnscored.mockRejectedValue(err);

    const result = await runBackgroundCycle('scoring-pass');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ service: 'run-background-cycle', reason: 'scoring-pass' }),
      }),
    );
  });

  it('tags keychain errors with kind=keychain-unavailable at warning level', async () => {
    const keychainErr = new Error('SecItem errSecInteractionNotAllowed keychain locked');
    mockHandlePush.mockRejectedValue(keychainErr);

    const result = await runBackgroundCycle('silent-push', 'req-1');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalledWith(
      keychainErr,
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ kind: 'keychain-unavailable' }),
      }),
    );
  });

  it('tags a transient abort with kind=transient-network at warning level', async () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    mockGetUnscored.mockRejectedValue(abortErr);

    const result = await runBackgroundCycle('scoring-pass');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalledWith(
      abortErr,
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ kind: 'transient-network' }),
      }),
    );
  });

  it('reports genuinely unexpected errors at error level with kind=generic', async () => {
    mockRecover.mockRejectedValue(new Error('some random failure'));

    await runBackgroundCycle('app-resume');

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ kind: 'generic' }),
      }),
    );
  });

  it('handles non-Error thrown values', async () => {
    mockHandlePush.mockRejectedValue('string error');
    const result = await runBackgroundCycle('phase1-done', 'req-1');
    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('runBackgroundCycle — context derivation', () => {
  it('calls contextForCycleReason with the provided reason', async () => {
    await runBackgroundCycle('silent-push', 'req-1');
    expect(mockContextForCycleReason).toHaveBeenCalledWith('silent-push');
  });
});

export {};
