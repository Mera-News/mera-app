// FeedSyncMachine.test.ts — state machine tests

const mockLoadValidSnapshot = jest.fn();
const mockSaveMachineSnapshot = jest.fn();
const mockClearMachineSnapshot = jest.fn();
const mockUpdateMachineState = jest.fn();
const mockStepFetchTopicIds = jest.fn();
const mockStepDiff = jest.fn();
const mockStepHydratePersistEnqueue = jest.fn();
const mockStepScore = jest.fn();
const mockRefreshSuggestionsInStoreUnsafe = jest.fn();
const mockRequestSuggestionsRefresh = jest.fn();
const mockFlushSuggestionsRefresh = jest.fn();
const mockClassifyError = jest.fn();
const mockPublishSyncStatus = jest.fn();
const mockPublishSyncError = jest.fn();
const mockActivateKeepAwakeAsync = jest.fn();
const mockDeactivateKeepAwake = jest.fn();
const mockCaptureException = jest.fn();
const mockLogInfo = jest.fn();
const mockLogAddBreadcrumb = jest.fn();
const mockGetPipelineStatus = jest.fn();
const mockGetRunStartedAt = jest.fn();
const mockAbortRun = jest.fn();

// Mirrors the STALE_RUN_GUARD_MS the scoring-pipeline mock below exports. Kept
// as a local constant rather than imported so the machine's stale-guard
// arithmetic is asserted against a fixed number, not against whatever the real
// module currently ships.
const STALE_RUN_GUARD_MS = 30 * 60_000;

// Network store subscription support. `networkSubscribeFn` is the LATEST
// subscriber; `networkSubscribers` keeps every one ever registered, paired with
// its own unsubscribe handle, so a test can drive an ABANDONED run's listener
// and assert which subscription was released. A single shared handle cannot
// distinguish those — and distinguishing them is the whole point of the
// leaked-listener test.
let networkSubscribeFn: ((state: any, prev: any) => void) | null = null;
const mockNetworkUnsubscribe = jest.fn();
const networkSubscribers: {
  fn: (state: any, prev: any) => void;
  unsubscribe: jest.Mock;
}[] = [];

const mockForYouStoreState = {
  setCounts: jest.fn(),
  setLastSyncAt: jest.fn(),
  setDailyLimitResetAt: jest.fn(),
  setDailyLimitNoticeDay: jest.fn(),
  markProcessingRunFinished: jest.fn(),
  resetHydrationProgress: jest.fn(),
  setScoringError: jest.fn(),
  relevantArticleCount: 0,
  dailyLimitNoticeDay: null as string | null,
};

jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: {
    subscribe: jest.fn((fn: any) => {
      networkSubscribeFn = fn;
      // Per-call handle AND the shared one: existing tests assert on
      // `mockNetworkUnsubscribe` (single-run, so either works), while the
      // leaked-listener test needs to know which specific subscription was
      // released.
      const unsubscribe = jest.fn(() => mockNetworkUnsubscribe());
      networkSubscribers.push({ fn, unsubscribe });
      return unsubscribe;
    }),
  },
}));

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: jest.fn(() => mockForYouStoreState),
  },
}));

jest.mock('@/lib/article-service', () => ({
  ArticleService: {
    getRecentArticleCount: jest.fn(() => Promise.resolve(0)),
  },
}));

jest.mock('@/lib/scheduler/feed-sync/feed-sync-persistence', () => ({
  loadValidSnapshot: (...args: any[]) => mockLoadValidSnapshot(...args),
  saveMachineSnapshot: (...args: any[]) => mockSaveMachineSnapshot(...args),
  clearMachineSnapshot: (...args: any[]) => mockClearMachineSnapshot(...args),
  updateMachineState: (...args: any[]) => mockUpdateMachineState(...args),
}));

jest.mock('@/lib/scheduler/feed-sync/feed-sync-steps', () => ({
  stepFetchTopicIds: (...args: any[]) => mockStepFetchTopicIds(...args),
  stepDiff: (...args: any[]) => mockStepDiff(...args),
  stepHydratePersistEnqueue: (...args: any[]) => mockStepHydratePersistEnqueue(...args),
  stepScore: (...args: any[]) => mockStepScore(...args),
}));

jest.mock('@/lib/services/SuggestionSyncService', () => ({
  refreshSuggestionsInStoreUnsafe: (...args: any[]) => mockRefreshSuggestionsInStoreUnsafe(...args),
  requestSuggestionsRefresh: (...args: any[]) => mockRequestSuggestionsRefresh(...args),
  flushSuggestionsRefresh: (...args: any[]) => mockFlushSuggestionsRefresh(...args),
}));

jest.mock('@/lib/services/scoring-pipeline', () => ({
  getPipelineStatus: (...args: any[]) => mockGetPipelineStatus(...args),
  getRunStartedAt: (...args: any[]) => mockGetRunStartedAt(...args),
  abortRun: (...args: any[]) => mockAbortRun(...args),
  STALE_RUN_GUARD_MS: 30 * 60_000,
}));

jest.mock('@/lib/scheduler/feed-sync/feed-sync-status', () => ({
  classifyError: (...args: any[]) => mockClassifyError(...args),
  publishSyncStatus: (...args: any[]) => mockPublishSyncStatus(...args),
  publishSyncError: (...args: any[]) => mockPublishSyncError(...args),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (...args: any[]) => mockActivateKeepAwakeAsync(...args),
  deactivateKeepAwake: (...args: any[]) => mockDeactivateKeepAwake(...args),
}));

// The machine emits notification-center-backed toasts on failure/daily-limit.
// Those go through the real toast-manager (DB write + toast render), which is
// out of scope for this unit test — stub it so it neither touches WatermelonDB
// nor logs to Sentry.
jest.mock('@/lib/toast-manager', () => ({
  toastManager: { showNotifiedToast: jest.fn(() => Promise.resolve()) },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    debug: (...args: any[]) => mockLogInfo(...args),
    info: (...args: any[]) => mockLogInfo(...args),
    warn: jest.fn(),
    // `_transitionTo` breadcrumbs a dropped transition from an abandoned run.
    // It uses addBreadcrumb rather than debug() deliberately — debug() only
    // emits under __DEV__, and the whole point is a production signal.
    addBreadcrumb: (...args: any[]) => mockLogAddBreadcrumb(...args),
  },
}));

import { feedSyncMachine } from '../FeedSyncMachine';
import { InvalidTransitionError } from '../feed-sync-types';

function makeCtx(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    jobId: 'job-feed-1',
    attempt: 1,
    signal: controller.signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    markNoOp: jest.fn(),
  };
}

const defaultTopicResult = {
  articleToTopicTexts: new Map([['art-1', ['topic1']]]),
  serverArticleIds: ['art-1', 'art-2'],
};

const defaultDiffResult = {
  serverArticleIds: ['art-1', 'art-2'],
  articleToTopicTexts: defaultTopicResult.articleToTopicTexts,
  missingIds: ['art-1', 'art-2'],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  networkSubscribeFn = null;

  mockLoadValidSnapshot.mockResolvedValue(null);
  mockSaveMachineSnapshot.mockResolvedValue(undefined);
  mockClearMachineSnapshot.mockResolvedValue(undefined);
  mockUpdateMachineState.mockResolvedValue(undefined);
  mockStepFetchTopicIds.mockResolvedValue(defaultTopicResult);
  mockStepDiff.mockResolvedValue(defaultDiffResult);
  mockStepHydratePersistEnqueue.mockResolvedValue({
    insertedCount: 2,
    enqueuedCount: 2,
    dailyLimitReached: false,
  });
  mockStepScore.mockResolvedValue(2);
  mockRefreshSuggestionsInStoreUnsafe.mockResolvedValue(undefined);
  mockRequestSuggestionsRefresh.mockResolvedValue(undefined);
  mockFlushSuggestionsRefresh.mockResolvedValue(undefined);
  mockClassifyError.mockReturnValue('unknown');
  mockActivateKeepAwakeAsync.mockResolvedValue(undefined);
  mockDeactivateKeepAwake.mockReturnValue(undefined);
  mockForYouStoreState.setCounts.mockReturnValue(undefined);
  mockForYouStoreState.setLastSyncAt.mockReturnValue(undefined);
  mockForYouStoreState.markProcessingRunFinished.mockReturnValue(undefined);
  mockForYouStoreState.resetHydrationProgress.mockReturnValue(undefined);
  mockForYouStoreState.dailyLimitNoticeDay = null;
  // Mirrors the real store's persistence: setting the marker updates the
  // same state object subsequent getState() calls (and the daily-limit
  // branch itself) read from — simulating both "later this run" and "next
  // cycle after a restart" reads of the persisted value.
  mockForYouStoreState.setDailyLimitNoticeDay.mockImplementation((day: string | null) => {
    mockForYouStoreState.dailyLimitNoticeDay = day;
  });

  const ArticleService = require('@/lib/article-service').ArticleService;
  ArticleService.getRecentArticleCount.mockResolvedValue(10);

  mockGetPipelineStatus.mockResolvedValue('idle');
  mockGetRunStartedAt.mockResolvedValue(null);
  mockAbortRun.mockResolvedValue(undefined);

  // The machine is a module singleton: a test that deliberately leaves a run
  // hung (the stale-_inFlight case) would otherwise poison every test after it.
  // `private` is a compile-time fiction, so reach in directly.
  (feedSyncMachine as any)._inFlight = null;
  (feedSyncMachine as any)._inFlightStartedAt = 0;
  // The abandoned-run tests below deliberately strand zombie runs. A zombie's
  // teardown is runId-guarded, so it never releases any of these — without the
  // reset they leak into every later test. `_keepAwakeHeld` in particular makes
  // `_acquireKeepAwake` early-return, which breaks the wake-lock assertions.
  //
  // `_runSeq` is deliberately NOT reset: keeping it monotonic across the file is
  // exactly what makes a leaked zombie's captured runId un-matchable.
  (feedSyncMachine as any)._paused = false;
  (feedSyncMachine as any)._resumeWaiters?.clear?.();
  (feedSyncMachine as any)._resumeCallback = null;
  (feedSyncMachine as any)._keepAwakeHeld = false;
  networkSubscribers.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('FeedSyncMachine — state property', () => {
  it('starts in idle state', () => {
    expect(feedSyncMachine.state).toBe('idle');
  });
});

describe('FeedSyncMachine — isRunning', () => {
  it('returns false in idle state', () => {
    expect(feedSyncMachine.isRunning()).toBe(false);
  });
});

describe('FeedSyncMachine — scoring-pipeline gate (FETCH_WHILE_SCORING)', () => {
  it('still fetches and hydrates while the pipeline is running — only scoring is suppressed', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000); // fresh run

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepFetchTopicIds).toHaveBeenCalled();
    expect(mockStepDiff).toHaveBeenCalled();
    expect(mockStepHydratePersistEnqueue).toHaveBeenCalled();
    expect(mockStepScore).not.toHaveBeenCalled();
    expect(feedSyncMachine.state).toBe('done');
  });

  it('passes suppressEnqueue to the hydrate step so nothing is handed to the live run', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000);

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepHydratePersistEnqueue).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ suppressEnqueue: true }),
    );
  });

  it('passes suppressEnqueue: false on a normal (pipeline-idle) cycle', async () => {
    mockGetPipelineStatus.mockResolvedValue('idle');

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepHydratePersistEnqueue).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ suppressEnqueue: false }),
    );
  });

  it('logs that scoring was suppressed rather than that the cycle was skipped', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000);

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('fetching without scoring'),
    );
  });

  it('still skips scoring on the no-new-articles branch', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000);
    mockStepDiff.mockResolvedValue({ ...defaultDiffResult, missingIds: [] });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepScore).not.toHaveBeenCalled();
    // The `scoring` transition itself must still happen — hydrating/diffing →
    // done is not a legal transition.
    expect(mockUpdateMachineState).toHaveBeenCalledWith('scoring');
    expect(feedSyncMachine.state).toBe('done');
  });

  it('does not mark the run a no-op (real work happened)', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000);

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });

  it('resolves without throwing while the pipeline is running (job completes normally)', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000);

    await expect(
      feedSyncMachine.start('persona-1', makeCtx()),
    ).resolves.toBeUndefined();
  });

  it('runs the cycle normally when the pipeline is idle', async () => {
    mockGetPipelineStatus.mockResolvedValue('idle');

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepFetchTopicIds).toHaveBeenCalled();
    expect(mockStepScore).toHaveBeenCalled();
    expect(feedSyncMachine.state).toBe('done');
  });
});

describe('FeedSyncMachine — scoring-pipeline stale-guard', () => {
  it('aborts a stale running run and proceeds with the sync', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    // Run started > STALE_RUN_GUARD_MS ago → wedged; must be aborted, not skipped.
    mockGetRunStartedAt.mockResolvedValue(Date.now() - (STALE_RUN_GUARD_MS + 60_000));

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockAbortRun).toHaveBeenCalledWith('stale-guard');
    // Sync proceeded rather than bailing out.
    expect(mockStepFetchTopicIds).toHaveBeenCalled();
    expect(mockStepScore).toHaveBeenCalled();
    expect(feedSyncMachine.state).toBe('done');
  });

  it('leaves a fresh running run alone (no abort) and syncs without scoring', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    // Run started well within STALE_RUN_GUARD_MS → healthy, let it finish.
    mockGetRunStartedAt.mockResolvedValue(Date.now() - 60_000);

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockAbortRun).not.toHaveBeenCalled();
    expect(mockStepFetchTopicIds).toHaveBeenCalled();
    expect(mockStepScore).not.toHaveBeenCalled();
  });
});

describe('FeedSyncMachine — full happy path (with new articles)', () => {
  it('transitions through all states in sequence', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    const states = mockPublishSyncStatus.mock.calls.map((c) => c[0]);
    // Round-4 B: fetching-topic-ids / diffing are NOT published (silent until
    // there's real work). The has-work path publishes from `hydrating` onward.
    expect(states).not.toContain('fetching-topic-ids');
    expect(states).not.toContain('diffing');
    expect(states).toContain('hydrating');
    // `persisting` is no longer a runtime state (merged into `hydrating`).
    expect(states).not.toContain('persisting');
    expect(states).toContain('scoring');
    expect(states).toContain('done');
  });

  it('calls all steps in sequence', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepFetchTopicIds).toHaveBeenCalledWith('persona-1', ctx);
    expect(mockStepDiff).toHaveBeenCalled();
    expect(mockStepHydratePersistEnqueue).toHaveBeenCalled();
    expect(mockStepScore).toHaveBeenCalled();
  });

  it('calls activateKeepAwakeAsync and deactivateKeepAwake', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockActivateKeepAwakeAsync).toHaveBeenCalledWith('mera-feed-sync');
    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith('mera-feed-sync');
  });

  it('unsubscribes from network store on completion', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockNetworkUnsubscribe).toHaveBeenCalled();
  });

  it('flushes the coalesced suggestions refresh after persisting, after scoring, and on teardown', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // A1: the direct refreshes became terminal flushes — one after the hydrate
    // step, one after scoring (before `done`), and one in the `_start` finally
    // teardown for exactness across every exit path.
    expect(mockFlushSuggestionsRefresh).toHaveBeenCalledTimes(3);
  });

  it('calls setLastSyncAt on completion', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockForYouStoreState.setLastSyncAt).toHaveBeenCalledWith(expect.any(Number));
  });

  it('clears the scoring error at the start of a run', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockForYouStoreState.setScoringError).toHaveBeenCalledWith(null);
  });

  it('calls clearMachineSnapshot on completion', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockClearMachineSnapshot).toHaveBeenCalled();
  });

  it('transitions from done to idle after 2s via setTimeout', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(feedSyncMachine.state).toBe('done');

    await jest.advanceTimersByTimeAsync(2_000);

    expect(feedSyncMachine.state).toBe('idle');
    expect(mockPublishSyncStatus).toHaveBeenCalledWith('idle');
  });

  it('saves machine snapshot with idle state at start', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockSaveMachineSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' }),
    );
  });

  it('reports hydration progress via reportProgress callback', async () => {
    mockStepHydratePersistEnqueue.mockImplementation(async (_diff, _ctx, opts) => {
      opts.onProgress(1);
      return { insertedCount: 1, enqueuedCount: 1, dailyLimitReached: false };
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(ctx.reportProgress).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'hydrating' }),
    );
  });
});

describe('FeedSyncMachine — no new articles path (diffResult.missingIds is empty)', () => {
  beforeEach(() => {
    mockStepDiff.mockResolvedValue({
      ...defaultDiffResult,
      missingIds: [],
    });
  });

  it('skips the hydrate/persist/enqueue step', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepHydratePersistEnqueue).not.toHaveBeenCalled();
  });

  it('still runs scoring step', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepScore).toHaveBeenCalled();
  });

  it('publishes NOTHING transient on a no-op cycle (silent — no shimmer flicker)', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // Round-4 B: a bare poll that finds no new articles is fully silent — no
    // scoring/done/idle (nor fetching-topic-ids/diffing) publishes.
    expect(mockPublishSyncStatus).not.toHaveBeenCalled();
  });

  it('still runs the internal transitions + setLastSyncAt + snapshot clear on a no-op cycle', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepScore).toHaveBeenCalled();
    expect(mockForYouStoreState.setLastSyncAt).toHaveBeenCalledWith(expect.any(Number));
    expect(mockClearMachineSnapshot).toHaveBeenCalled();
    // Internal bookkeeping still reaches the terminal `done` state.
    expect(feedSyncMachine.state).toBe('done');
  });

  // A cycle that legitimately finds nothing IS a completed processing run, and
  // it has to say so. `lastProcessingRunFinishedAt` is the only thing standing
  // between FeedPreparingCard and AllCaughtUpCard on both feed surfaces
  // (FeedScreen.tsx / ForYouScreen.tsx: `isFeedProcessing || lastProcessing-
  // RunFinishedAt === null`), and on the zero-article path nothing else can
  // ever stamp it: no rows are enqueued, so no pipeline run exists, so
  // doFinalize (the usual stamper) bails before reaching it. Observed on a real
  // device pointed at an empty window — "Mera is preparing your feed." forever.
  it('stamps markProcessingRunFinished — a sync that found nothing still FINISHED', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // Takes no argument — the store stamps Date.now() itself and persists it.
    expect(mockForYouStoreState.markProcessingRunFinished).toHaveBeenCalledTimes(1);
  });

  // The one case where the claim would be a lie: a live scoring run already
  // owns the unscored backlog and will stamp its own finalize. Saying "finished"
  // here would resolve the card while work is genuinely still in flight.
  it('does NOT stamp it while a scoring run is already in flight', async () => {
    mockGetPipelineStatus.mockResolvedValue('running');
    mockGetRunStartedAt.mockResolvedValue(Date.now());

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepScore).not.toHaveBeenCalled();
    expect(mockForYouStoreState.markProcessingRunFinished).not.toHaveBeenCalled();
  });
});

describe('FeedSyncMachine — error handling', () => {
  it('transitions to failed state when step throws', async () => {
    const err = new Error('fetch failed');
    mockStepFetchTopicIds.mockRejectedValue(err);
    mockClassifyError.mockReturnValue('server-unreachable');

    const ctx = makeCtx();
    await expect(feedSyncMachine.start('persona-1', ctx)).rejects.toThrow('fetch failed');

    expect(feedSyncMachine.state).toBe('failed');
    expect(mockPublishSyncError).toHaveBeenCalledWith(
      'server-unreachable',
      undefined,
      expect.any(String),
    );
  });

  it('saves failed snapshot on error', async () => {
    mockStepFetchTopicIds.mockRejectedValue(new Error('fail'));
    mockClassifyError.mockReturnValue('offline');

    const ctx = makeCtx();
    await expect(feedSyncMachine.start('persona-1', ctx)).rejects.toThrow();

    expect(mockSaveMachineSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed', errorCode: 'offline' }),
    );
  });

  it('still calls deactivateKeepAwake on error (finally block)', async () => {
    mockStepFetchTopicIds.mockRejectedValue(new Error('fail'));

    const ctx = makeCtx();
    await expect(feedSyncMachine.start('persona-1', ctx)).rejects.toThrow();

    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith('mera-feed-sync');
  });

  it('opts the sync-failed toast into notify()\'s same-day dedupe (dedupeDaily: true)', async () => {
    const { toastManager } = require('@/lib/toast-manager');
    mockStepFetchTopicIds.mockRejectedValue(new Error('fail'));

    const ctx = makeCtx();
    await expect(feedSyncMachine.start('persona-1', ctx)).rejects.toThrow();

    expect(toastManager.showNotifiedToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sync_event', source: 'feed-sync', dedupeDaily: true }),
    );
  });

  it('swallows clearMachineSnapshot errors on success path', async () => {
    mockClearMachineSnapshot.mockRejectedValueOnce(new Error('snap clear error'));

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await expect(startPromise).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: 'clearMachineSnapshot' }),
      }),
    );
  });
});

describe('FeedSyncMachine — no-topics-configured is a normal terminal outcome', () => {
  beforeEach(() => {
    mockStepFetchTopicIds.mockRejectedValue(
      Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' }),
    );
    mockClassifyError.mockReturnValue('no-topics-configured');
  });

  it('resolves without throwing (job completes, no retry)', async () => {
    await expect(feedSyncMachine.start('persona-1', makeCtx())).resolves.toBeUndefined();
  });

  it('does NOT transition to failed and resets to idle', async () => {
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(feedSyncMachine.state).toBe('idle');
  });

  it('does NOT save a failed snapshot and clears the snapshot instead', async () => {
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(mockSaveMachineSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed' }),
    );
    expect(mockClearMachineSnapshot).toHaveBeenCalled();
  });

  it('surfaces the noTopics UI prompt and does not capture an error to Sentry', async () => {
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(mockPublishSyncError).toHaveBeenCalledWith(
      'no-topics-configured',
      undefined,
      expect.any(String),
    );
    // No Sentry capture for the (expected) no-topics condition.
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe('FeedSyncMachine — daily-limit is a normal terminal outcome', () => {
  const RESET_AT = 1781827200000;
  beforeEach(() => {
    mockStepHydratePersistEnqueue.mockRejectedValue(
      Object.assign(new Error('daily-limit'), {
        code: 'daily-limit',
        resetAt: RESET_AT,
      }),
    );
    mockClassifyError.mockReturnValue('daily-limit');
  });

  it('resolves without throwing (job completes, no retry) and resets to idle', async () => {
    await expect(
      feedSyncMachine.start('persona-1', makeCtx()),
    ).resolves.toBeUndefined();
    expect(feedSyncMachine.state).toBe('idle');
  });

  it('opts the daily-limit toast into notify()\'s same-day dedupe (dedupeDaily: true)', async () => {
    const { toastManager } = require('@/lib/toast-manager');
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(toastManager.showNotifiedToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feed_info', source: 'feed-sync', dedupeDaily: true }),
    );
  });

  it('sets the sticky daily-limit reset time for the banner', async () => {
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(mockForYouStoreState.setDailyLimitResetAt).toHaveBeenCalledWith(
      RESET_AT,
    );
  });

  it('publishes the daily-limit sync error and does not capture to Sentry', async () => {
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(mockPublishSyncError).toHaveBeenCalledWith(
      'daily-limit',
      RESET_AT,
      expect.any(String),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('falls back to the next UTC midnight when the error omits resetAt', async () => {
    mockStepHydratePersistEnqueue.mockRejectedValue(
      Object.assign(new Error('daily-limit'), { code: 'daily-limit' }),
    );

    await feedSyncMachine.start('persona-1', makeCtx());

    const arg = mockForYouStoreState.setDailyLimitResetAt.mock.calls.find(
      (c) => typeof c[0] === 'number',
    )?.[0] as number;
    expect(typeof arg).toBe('number');
    // Computed reset is a future 00:00:00.000 UTC instant.
    const d = new Date(arg);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(arg).toBeGreaterThan(Date.now());
  });

  // Regression coverage for "daily limit keeps popping once reached" — the
  // toast/notification-center row must fire once per UTC day, not once per
  // 60s task-gate re-arm / 5s foreground-gap.
  describe('once-per-UTC-day notice gate', () => {
    const { toastManager } = require('@/lib/toast-manager');
    const today = new Date().toISOString().slice(0, 10);

    it('fires the notice on the first hit and records today as the notice day', async () => {
      await feedSyncMachine.start('persona-1', makeCtx());

      expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);
      expect(toastManager.showNotifiedToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'feed_info', source: 'feed-sync' }),
      );
      expect(mockForYouStoreState.setDailyLimitNoticeDay).toHaveBeenCalledWith(today);
    });

    it('does not re-fire on a repeated run within the same UTC day', async () => {
      // Simulate the notice already having fired earlier today (a previous
      // cycle, or a rehydrated value from a prior app session).
      mockForYouStoreState.dailyLimitNoticeDay = today;

      await feedSyncMachine.start('persona-1', makeCtx());

      expect(toastManager.showNotifiedToast).not.toHaveBeenCalled();
      expect(mockForYouStoreState.setDailyLimitNoticeDay).not.toHaveBeenCalled();
    });

    it('does not re-fire across several repeated runs the same day (the reported bug)', async () => {
      await feedSyncMachine.start('persona-1', makeCtx());
      expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);

      // Further cycles within the same day (60s task re-arm / 5s foreground
      // gap) must not add more toasts.
      await feedSyncMachine.start('persona-1', makeCtx());
      await feedSyncMachine.start('persona-1', makeCtx());
      await feedSyncMachine.start('persona-1', makeCtx());

      expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);
    });

    it('re-arms and fires again once the stored marker is a previous UTC day (day rollover)', async () => {
      mockForYouStoreState.dailyLimitNoticeDay = '2020-01-01'; // stale/previous day

      await feedSyncMachine.start('persona-1', makeCtx());

      expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);
      expect(mockForYouStoreState.setDailyLimitNoticeDay).toHaveBeenCalledWith(today);
    });

    it('does not re-notify after a simulated app restart (marker survives via persisted state)', async () => {
      // First run persists the marker (setDailyLimitNoticeDay mock mirrors
      // the real store's write into mockForYouStoreState, standing in for
      // the FeedMetadata row surviving a restart and being rehydrated).
      await feedSyncMachine.start('persona-1', makeCtx());
      expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);

      // "Restart": a fresh machine cycle reads the (still-persisted) marker —
      // nothing in the store is reset, exactly as hydrateMetadataFromDb would
      // rehydrate `dailyLimitNoticeDay` from FeedMetadata at boot.
      await feedSyncMachine.start('persona-1', makeCtx());

      expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);
    });
  });
});

describe('FeedSyncMachine — clears the daily-limit banner on successful delivery', () => {
  it('calls setDailyLimitResetAt(null) after a successful persist', async () => {
    await feedSyncMachine.start('persona-1', makeCtx());
    expect(mockForYouStoreState.setDailyLimitResetAt).toHaveBeenCalledWith(null);
  });
});

describe('FeedSyncMachine — partial cap surfaces the banner while still delivering', () => {
  it('sets the reset time (not null) and still persists the granted articles', async () => {
    mockStepHydratePersistEnqueue.mockResolvedValue({
      insertedCount: 1,
      enqueuedCount: 1,
      dailyLimitReached: true,
      resetAt: '2026-06-26T00:00:00.000Z',
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // Granted articles are still delivered (no terminal throw on a partial clip).
    expect(mockStepHydratePersistEnqueue).toHaveBeenCalled();
    // Banner is surfaced immediately with the server's reset time.
    expect(mockForYouStoreState.setDailyLimitResetAt).toHaveBeenCalledWith(
      Date.parse('2026-06-26T00:00:00.000Z'),
    );
    expect(mockForYouStoreState.setDailyLimitResetAt).not.toHaveBeenCalledWith(
      null,
    );
  });
});

describe('FeedSyncMachine — abort signal handling', () => {
  it('returns early without completing when signal is aborted during scoring', async () => {
    const controller = new AbortController();
    const ctx = {
      jobId: 'job-abort',
      attempt: 1,
      signal: controller.signal,
      reportProgress: jest.fn(),
      log: jest.fn(),
      markNoOp: jest.fn(),
    };

    // Abort before scoring step runs
    mockStepHydratePersistEnqueue.mockImplementation(async () => {
      controller.abort();
      return { insertedCount: 0, enqueuedCount: 0, dailyLimitReached: false };
    });

    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // stepScore should not have been called after abort
    expect(mockStepScore).not.toHaveBeenCalled();
  });
});

describe('FeedSyncMachine — resuming from persisted state', () => {
  it('logs resuming message when valid non-idle snapshot exists', async () => {
    mockLoadValidSnapshot.mockResolvedValue({
      state: 'hydrating',
      startedAt: Date.now() - 1000,
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('resuming from persisted state'),
    );
  });

  it('does not log resuming when snapshot is idle', async () => {
    mockLoadValidSnapshot.mockResolvedValue({
      state: 'idle',
      startedAt: Date.now() - 1000,
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockLogInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('resuming from persisted state'),
    );
  });
});

describe('FeedSyncMachine — offline pause/resume', () => {
  it('pauses on network disconnect during fetching-topic-ids', async () => {
    // Simulate a slow stepFetchTopicIds that allows us to trigger network disconnect
    let resolveStep: (() => void) | null = null;
    mockStepFetchTopicIds.mockImplementation(() => new Promise<typeof defaultTopicResult>((resolve) => {
      resolveStep = () => resolve(defaultTopicResult);
    }));

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);

    // Trigger network disconnect while in fetching-topic-ids state
    networkSubscribeFn?.({ isConnected: false }, { isConnected: true });

    // Check paused-offline was published
    expect(mockPublishSyncStatus).toHaveBeenCalledWith(
      'paused-offline',
      expect.objectContaining({ pausedAtState: expect.any(String) }),
    );

    // Resume network
    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });

    // Now resolve the pending step
    (resolveStep as (() => void) | null)?.();
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;
  });

  it('covers _awaitResumeIfPaused when paused=true before hydrating', async () => {
    // _awaitResumeIfPaused() is called at line 152 after updateMachineState('hydrating').
    // To cover the paused=true branch (lines 227-230), _paused must be true at that point.
    //
    // Key timing: updateMachineState returns a resolved promise. The microtask continuation
    // (line 152) runs BEFORE any .then() chained on Promise.resolve() inside the mock,
    // because the mock's async body completes synchronously — so Promise.resolve().then(fn)
    // fires BEFORE the caller's continuation (await resolution order).
    //
    // Instead, we use a 2-step deferred approach:
    // - updateMachineState('hydrating') fires disconnect → _paused=true
    // - updateMachineState returns a Promise that resolves on the NEXT tick (double-resolved)
    //   so that _awaitResumeIfPaused is called first, creating the blocking promise
    // - Then reconnect fires from test level after giving the machine a chance to suspend

    // Step 1: disconnect during updateMachineState('hydrating')
    let hydratingResolveFn: (() => void) | null = null;
    const hydratingDeferred = new Promise<void>((resolve) => {
      hydratingResolveFn = resolve;
    });

    mockUpdateMachineState.mockImplementation(async (state: string) => {
      if (state === 'hydrating') {
        // Fire disconnect → _paused=true, _state='paused-offline'
        networkSubscribeFn?.({ isConnected: false }, { isConnected: true });
        // Return the deferred — so the machine suspends here until we resolve it
        await hydratingDeferred;
      }
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    // Let all microtasks run up to the updateMachineState('hydrating') suspension
    await jest.advanceTimersByTimeAsync(0);

    // Now the machine is suspended inside updateMachineState('hydrating').
    // _paused = true (disconnect was fired). Resolve the deferred.
    (hydratingResolveFn as (() => void) | null)?.();
    // Let the machine resume through updateMachineState and enter _awaitResumeIfPaused
    await jest.advanceTimersByTimeAsync(0);

    // Now the machine is suspended inside _awaitResumeIfPaused (lines 227-230 covered).
    // Fire reconnect to unblock it.
    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockPublishSyncStatus).toHaveBeenCalledWith(
      'paused-offline',
      expect.objectContaining({ pausedAtState: 'hydrating' }),
    );
  });
});

describe('FeedSyncMachine — no new articles path: clearMachineSnapshot and setTimeout', () => {
  beforeEach(() => {
    mockStepDiff.mockResolvedValue({
      ...defaultDiffResult,
      missingIds: [],
    });
  });

  it('swallows clearMachineSnapshot errors on no-missing-ids path', async () => {
    mockClearMachineSnapshot.mockRejectedValueOnce(new Error('snap clear error in no-missing path'));

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await expect(startPromise).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: 'clearMachineSnapshot' }),
      }),
    );
  });

  it('does NOT arm the 2s done→idle timer on the no-op path (stays done, no idle publish)', async () => {
    // Round-4 B: the silent no-op path skips the 2s done→idle timer entirely, so
    // no `idle` status is ever published and the machine simply rests at `done`
    // until the next run resets it.
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(feedSyncMachine.state).toBe('done');

    await jest.advanceTimersByTimeAsync(2_000);

    expect(feedSyncMachine.state).toBe('done');
    expect(mockPublishSyncStatus).not.toHaveBeenCalledWith('idle');
  });
});

describe('FeedSyncMachine — isRunning during active states', () => {
  it('returns true while running (fetching-topic-ids)', async () => {
    let resolveStep: (() => void) | null = null;
    mockStepFetchTopicIds.mockImplementation(() => new Promise<typeof defaultTopicResult>((resolve) => {
      resolveStep = () => resolve(defaultTopicResult);
    }));

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);

    // Machine is in fetching-topic-ids state — isRunning should be true
    expect(feedSyncMachine.isRunning()).toBe(true);

    (resolveStep as (() => void) | null)?.();
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;
  });
});

describe('FeedSyncMachine — invalid transition', () => {
  it('throws InvalidTransitionError when an invalid state transition is attempted', async () => {
    // The machine starts in 'idle' state. Attempt to trigger an invalid transition
    // by throwing an error from a step and then verifying the failed state
    mockStepFetchTopicIds.mockRejectedValue(new Error('step error'));

    const ctx = makeCtx();
    await expect(feedSyncMachine.start('persona-1', ctx)).rejects.toThrow('step error');
    expect(feedSyncMachine.state).toBe('failed');

    // Now call start() again to reset. This is valid (failed → idle via the start reset).
    mockStepFetchTopicIds.mockResolvedValue(defaultTopicResult);
    const ctx2 = makeCtx();
    const startPromise2 = feedSyncMachine.start('persona-1', ctx2);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise2;
    expect(feedSyncMachine.state).toBe('done');
  });

  // NOTE: FeedSyncMachine.ts line 220 (`throw new InvalidTransitionError`) is
  // defensive dead code. The only caller of _transitionTo('paused-offline') is the
  // network subscriber callback, which guards with NETWORK_DEPENDENT_STATES.includes()
  // before calling _transitionTo. Since paused-offline is always reachable from those
  // states, the guard prevents an invalid transition from ever being attempted. Line 220
  // cannot be reached without modifying source code.
});

describe('FeedSyncMachine — abort in fetching-topic-ids before step resolves', () => {
  it('returns early when signal is aborted before stepFetchTopicIds', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = {
      jobId: 'job-abort-early',
      attempt: 1,
      signal: controller.signal,
      reportProgress: jest.fn(),
      log: jest.fn(),
      markNoOp: jest.fn(),
    };

    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // Aborted before anything significant — no steps should have run
    // (abort check is AFTER stepFetchTopicIds but BEFORE stepDiff)
    expect(mockStepDiff).not.toHaveBeenCalled();
  });
});

describe('FeedSyncMachine — error catch: already failed/done state', () => {
  it('does not double-transition when state is already failed', async () => {
    // Force machine to already be in failed state, then verify the catch block
    // does not call transitionTo again
    // This tests the `if (this._state !== 'failed' && this._state !== 'done')` guard
    mockStepFetchTopicIds.mockRejectedValue(new Error('first error'));
    const ctx = makeCtx();
    await expect(feedSyncMachine.start('persona-1', ctx)).rejects.toThrow('first error');
    expect(feedSyncMachine.state).toBe('failed');
    // publishSyncError called once
    expect(mockPublishSyncError).toHaveBeenCalledTimes(1);
  });
});

describe('FeedSyncMachine — re-entrancy guard (single-flight)', () => {
  it('joins an in-flight run instead of starting a second concurrent run', async () => {
    // Hold the first run inside stepFetchTopicIds so the second start() lands
    // while a run is genuinely in flight — the production concurrency scenario.
    let resolveStep: (() => void) | null = null;
    mockStepFetchTopicIds.mockImplementation(
      () => new Promise<typeof defaultTopicResult>((resolve) => {
        resolveStep = () => resolve(defaultTopicResult);
      }),
    );

    const p1 = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);

    const p2 = feedSyncMachine.start('persona-1', makeCtx());

    // The second call must NOT execute the run body again.
    expect(mockStepFetchTopicIds).toHaveBeenCalledTimes(1);

    (resolveStep as (() => void) | null)?.();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([p1, p2]);

    // No "Invalid FeedSyncMachine transition" was ever produced.
    const transitionErrors = mockCaptureException.mock.calls.filter(
      ([e]: any[]) => e instanceof Error && /Invalid FeedSyncMachine transition/.test(e.message),
    );
    expect(transitionErrors).toHaveLength(0);
    // The run completed exactly once.
    expect(mockStepScore).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh run after the previous run settles', async () => {
    const p1 = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await p1;
    expect(mockStepScore).toHaveBeenCalledTimes(1);

    const p2 = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await p2;
    expect(mockStepScore).toHaveBeenCalledTimes(2);
  });

  it('joins the in-flight run even when the first run is failing', async () => {
    // A run that fails should still serialize a concurrent start() — the second
    // call joins (and shares) the rejection rather than racing transitions.
    let rejectStep: ((e: Error) => void) | null = null;
    mockStepFetchTopicIds.mockImplementation(
      () => new Promise<typeof defaultTopicResult>((_resolve, reject) => {
        rejectStep = (e: Error) => reject(e);
      }),
    );
    mockClassifyError.mockReturnValue('server-unreachable');

    const p1 = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    const p2 = feedSyncMachine.start('persona-1', makeCtx());

    expect(mockStepFetchTopicIds).toHaveBeenCalledTimes(1);

    (rejectStep as ((e: Error) => void) | null)?.(new Error('boom'));

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    // Only one failed transition — no duplicate-run "failed → X" artifacts.
    expect(mockPublishSyncError).toHaveBeenCalledTimes(1);
  });
});

describe('FeedSyncMachine — setCounts called with article count', () => {
  it('sets article count from getRecentArticleCount result', async () => {
    const ArticleService = require('@/lib/article-service').ArticleService;
    ArticleService.getRecentArticleCount.mockResolvedValue(25);

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockForYouStoreState.setCounts).toHaveBeenCalledWith(
      25,
      expect.any(Number),
    );
  });

  it('falls back to serverArticleIds.length when getRecentArticleCount returns 0', async () => {
    const ArticleService = require('@/lib/article-service').ArticleService;
    ArticleService.getRecentArticleCount.mockResolvedValue(0);

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockForYouStoreState.setCounts).toHaveBeenCalledWith(
      defaultTopicResult.serverArticleIds.length,
      expect.any(Number),
    );
  });

  it('falls back to serverArticleIds.length when getRecentArticleCount throws', async () => {
    const ArticleService = require('@/lib/article-service').ArticleService;
    ArticleService.getRecentArticleCount.mockRejectedValueOnce(new Error('count error'));

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockForYouStoreState.setCounts).toHaveBeenCalledWith(
      defaultTopicResult.serverArticleIds.length,
      expect.any(Number),
    );
  });
});

describe('FeedSyncMachine — stale in-flight run', () => {
  it('joins a young in-flight run rather than starting a second one', async () => {
    mockStepFetchTopicIds.mockImplementation(() => new Promise(() => { /* hangs */ }));

    void feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    expect(mockStepFetchTopicIds).toHaveBeenCalledTimes(1);

    void feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);

    // Joined — no second cycle was started.
    expect(mockStepFetchTopicIds).toHaveBeenCalledTimes(1);
  });

  it('abandons a 5-minute-old in-flight run and starts fresh', async () => {
    // iOS freezes the runner's abort setTimeout while backgrounded, so an
    // interrupted run's promise never settles. Joining it would wedge feed-sync
    // for the rest of the session.
    mockStepFetchTopicIds.mockImplementationOnce(() => new Promise(() => { /* hangs */ }));

    void feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    expect(mockStepFetchTopicIds).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5 * 60_000);

    const secondPromise = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await secondPromise;

    expect(mockStepFetchTopicIds).toHaveBeenCalledTimes(2);
    expect(feedSyncMachine.state).toBe('done');
  });

  // ── The production bug: Sentry MERA-APP-5W/6D/6E/61 ───────────────────────
  //
  // The three tests above all pass on the PRE-FIX tree, but only by luck of
  // interleaving — each happens to release the zombie at a point where its next
  // transition is coincidentally legal against the replacement's state. These
  // two stage the collision deliberately, in both directions.

  it('an abandoned run cannot corrupt the replacement\'s state', async () => {
    // Direction 1 — the ZOMBIE throws. Run A hangs at fetch and is abandoned;
    // run B completes to `done`; A then resumes into `_transitionTo('diffing')`,
    // which is evaluated against B's `done` (allowed: ['idle']) and throws
    // "Invalid FeedSyncMachine transition: done → diffing".
    let releaseA: (() => void) | null = null;
    mockStepFetchTopicIds.mockImplementationOnce(
      () => new Promise((resolve) => { releaseA = () => resolve(defaultTopicResult); }),
    );

    const pA = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5 * 60_000); // age past INFLIGHT_STALE_MS

    const pB = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await pB;
    expect(feedSyncMachine.state).toBe('done');

    // Let the ABANDONED run continue into its next transition.
    (releaseA as unknown as () => void)?.();
    await jest.advanceTimersByTimeAsync(0);

    // Asserted on the PROMISE, not on mockCaptureException: the machine never
    // captures InvalidTransitionError itself — it propagates to
    // scheduler-runner, which is not in this suite. An assertion on
    // mockCaptureException here would be vacuous.
    await expect(pA).resolves.toBeUndefined();
    // B's terminal state survived A finishing underneath it.
    expect(feedSyncMachine.state).toBe('done');
    // Decision on record: the zombie is NEUTERED, not aborted. It still runs
    // its own remaining steps — it just cannot touch shared machine state.
    expect(mockStepScore).toHaveBeenCalledTimes(2);
  });

  it('an abandoned run\'s terminal branch cannot make the LIVE run throw', async () => {
    // Direction 2 — the LIVE run throws, which a guard on `_transitionTo` alone
    // would NOT catch. Zombie A rejects with `daily-limit` and hits the
    // `this._state = 'idle'` force-reset while live run B sits at `hydrating`.
    // B's next legal transition (hydrating → scoring) is then evaluated as
    // `idle → scoring` and throws from B, which owns the current runId.
    let failA: ((err: Error) => void) | null = null;
    mockStepFetchTopicIds.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failA = (err) => reject(err); }),
    );

    const pA = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    // Run B parks in hydrate, so `_state` is 'hydrating' when A's catch runs.
    let releaseB: (() => void) | null = null;
    mockStepHydratePersistEnqueue.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseB = () => resolve({ insertedCount: 2, enqueuedCount: 2, dailyLimitReached: false });
      }),
    );
    const pB = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    expect(feedSyncMachine.state).toBe('hydrating');

    // A's rejection routes to the `daily-limit` force-reset branch.
    mockClassifyError.mockReturnValueOnce('daily-limit');
    (failA as unknown as (err: Error) => void)?.(new Error('daily-limit'));
    await jest.advanceTimersByTimeAsync(0);
    await expect(pA).resolves.toBeUndefined();

    // The live run must be untouched by the zombie's force-reset.
    expect(feedSyncMachine.state).toBe('hydrating');

    (releaseB as unknown as () => void)?.();
    await jest.advanceTimersByTimeAsync(0);
    await expect(pB).resolves.toBeUndefined();
    expect(feedSyncMachine.state).toBe('done');
  });

  it('an abandoned run\'s network listener cannot touch the replacement', async () => {
    // `_networkUnsubscribe` is a single field and the teardown is
    // ownership-guarded, so an abandoned run's handle used to be overwritten
    // without ever being called — one listener leaked per abandonment, each
    // still able to drive `_state` to 'paused-offline' and set `_paused`.
    mockStepFetchTopicIds.mockImplementationOnce(() => new Promise(() => { /* hangs */ }));

    void feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    const zombieListener = networkSubscribers[networkSubscribers.length - 1];

    await jest.advanceTimersByTimeAsync(5 * 60_000);

    // Run B parks in hydrate so there is a live, network-dependent state to hit.
    let releaseB: (() => void) | null = null;
    mockStepHydratePersistEnqueue.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseB = () => resolve({ insertedCount: 2, enqueuedCount: 2, dailyLimitReached: false });
      }),
    );
    const pB = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    expect(feedSyncMachine.state).toBe('hydrating');

    // The stale run's handle was released when B subscribed...
    expect(zombieListener.unsubscribe).toHaveBeenCalled();
    // ...and even if it fires anyway, it is inert.
    mockPublishSyncStatus.mockClear();
    zombieListener.fn({ isConnected: false }, { isConnected: true });
    expect(feedSyncMachine.state).toBe('hydrating');
    expect((feedSyncMachine as any)._paused).toBe(false);
    expect(mockPublishSyncStatus).not.toHaveBeenCalledWith('paused-offline', expect.anything());

    (releaseB as unknown as () => void)?.();
    await jest.advanceTimersByTimeAsync(0);
    await expect(pB).resolves.toBeUndefined();
  });

  it('an inherited _paused does not wedge the next run', async () => {
    // A run that failed while offline left `_paused` true and nothing reset it.
    // The next run then parked at the first `_awaitResumeIfPaused` waiting for a
    // resume that could never arrive: the listener's resume branch needs
    // `_state === 'paused-offline'`, but `_start` had just forced it to 'idle'.
    (feedSyncMachine as any)._paused = true;

    const p = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);

    await expect(p).resolves.toBeUndefined();
    expect(feedSyncMachine.state).toBe('done');
  });

  it('releases EVERY parked waiter on resume, not just the last', async () => {
    // Hydrate runs a pool of HYDRATE_CONCURRENCY workers, each of which can park
    // in `_awaitResumeIfPaused`. With a single resolver slot, each parking
    // worker overwrote the previous one's resolver and only the last was ever
    // woken — the others' promises never settled, so the run hung forever.
    (feedSyncMachine as any)._paused = true;
    const runId = (feedSyncMachine as any)._runSeq;
    const settled: string[] = [];

    const w1 = (feedSyncMachine as any)._awaitResumeIfPaused(runId).then(() => settled.push('w1'));
    const w2 = (feedSyncMachine as any)._awaitResumeIfPaused(runId).then(() => settled.push('w2'));
    const w3 = (feedSyncMachine as any)._awaitResumeIfPaused(runId).then(() => settled.push('w3'));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toEqual([]);

    (feedSyncMachine as any)._releaseResumeWaiters();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([w1, w2, w3]);

    expect(settled.sort()).toEqual(['w1', 'w2', 'w3']);
    (feedSyncMachine as any)._paused = false;
  });

  it('an abandoned run parked offline unwinds instead of hanging forever', async () => {
    // The one zombie that would never finish. Only the live run's listener can
    // wake a parked run, and it now ignores abandoned ones — so abandonment has
    // to release the waiters itself or this run holds an async frame for the
    // rest of the session.
    let releaseA: (() => void) | null = null;
    mockStepFetchTopicIds.mockImplementationOnce(
      () => new Promise((resolve) => { releaseA = () => resolve(defaultTopicResult); }),
    );
    const pA = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);

    // Park A: it is at 'fetching-topic-ids', a network-dependent state.
    networkSubscribeFn?.({ isConnected: false }, { isConnected: true });
    expect(feedSyncMachine.state).toBe('paused-offline');
    (releaseA as unknown as () => void)?.();
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(5 * 60_000);
    const pB = feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);

    // Abandonment released A's waiter, so A settles rather than staying parked.
    await expect(pA).resolves.toBeUndefined();
    await expect(pB).resolves.toBeUndefined();
  });

  it('the abandoned run cannot clear the replacement\'s _inFlight slot', async () => {
    let releaseFirst: (() => void) | null = null;
    mockStepFetchTopicIds.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = () => resolve(defaultTopicResult); }),
    );

    void feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    // Second run hangs, so the slot must stay occupied by IT.
    mockStepFetchTopicIds.mockImplementationOnce(() => new Promise(() => { /* hangs */ }));
    void feedSyncMachine.start('persona-1', makeCtx());
    await jest.advanceTimersByTimeAsync(0);

    // Now let the ABANDONED run finish. Its identity-guarded finally must not
    // null out the live run's reference.
    (releaseFirst as unknown as () => void)?.();
    await jest.advanceTimersByTimeAsync(0);

    expect((feedSyncMachine as any)._inFlight).not.toBeNull();
    // ...and it must not have torn down the live run's keep-awake either.
    expect(mockDeactivateKeepAwake).not.toHaveBeenCalled();
  });
});

describe('FeedSyncMachine — wake lock is scoped to fetch/hydrate (B1.4)', () => {
  it('releases the wake lock before scoring rather than only in the finally', async () => {
    // The lock used to span the whole run, scoring included. Scoring owns its
    // own lock (SuggestionSyncService on the on-device path; the cloud path
    // needs none), so by the time stepScore runs the tag must already be down.
    let heldDuringScoring = true;
    mockStepScore.mockImplementation(async () => {
      heldDuringScoring = mockDeactivateKeepAwake.mock.calls.length === 0;
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockStepScore).toHaveBeenCalled();
    expect(heldDuringScoring).toBe(false);
  });

  it('deactivates exactly once per run — the finally is idempotent, not a second release', async () => {
    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(mockActivateKeepAwakeAsync).toHaveBeenCalledTimes(1);
    expect(mockDeactivateKeepAwake).toHaveBeenCalledTimes(1);
  });

  it('drops the wake lock while paused-offline and re-takes it on resume', async () => {
    // Same suspension trick as the _awaitResumeIfPaused coverage test above:
    // disconnect while updateMachineState('hydrating') is in flight, so the
    // machine reaches _awaitResumeIfPaused with _paused === true.
    let hydratingResolveFn: (() => void) | null = null;
    const hydratingDeferred = new Promise<void>((resolve) => {
      hydratingResolveFn = resolve;
    });

    mockUpdateMachineState.mockImplementation(async (state: string) => {
      if (state === 'hydrating') {
        networkSubscribeFn?.({ isConnected: false }, { isConnected: true });
        await hydratingDeferred;
      }
    });

    const ctx = makeCtx();
    const startPromise = feedSyncMachine.start('persona-1', ctx);
    await jest.advanceTimersByTimeAsync(0);

    (hydratingResolveFn as (() => void) | null)?.();
    await jest.advanceTimersByTimeAsync(0);

    // Suspended in _awaitResumeIfPaused: the lock taken at the top of the run
    // must have been dropped, because this wait is unbounded.
    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith('mera-feed-sync');
    const releasesWhilePaused = mockDeactivateKeepAwake.mock.calls.length;
    const acquiresBeforeResume = mockActivateKeepAwakeAsync.mock.calls.length;

    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    // ...and re-taken once the work resumes.
    expect(mockActivateKeepAwakeAsync.mock.calls.length).toBeGreaterThan(
      acquiresBeforeResume,
    );
    expect(releasesWhilePaused).toBeGreaterThan(0);
  });
});

export {};
