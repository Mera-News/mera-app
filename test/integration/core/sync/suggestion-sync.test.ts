// SuggestionSyncService: the scoring pass, and the throttled refresh that puts stored suggestions
// into the For You store.
//
// Real stores, real article_suggestions on the in-memory DB, real scoring pipeline and gateway
// mock in cloud mode, real local scoring over a faked llama.rn context in on-device mode. Only the
// native edges are mocked: llama.rn, expo-file-system (the model file), expo-keep-awake, the logger.
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { invalidateJwtCache } from '@/lib/auth-client';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import {
  __resetSuggestionsRefreshThrottleForTests,
  flushSuggestionsRefresh,
  refreshSuggestionsInStoreUnsafe,
  REFRESH_MIN_INTERVAL_MS,
  requestSuggestionsRefresh,
  runScoringPass,
} from '@/lib/services/SuggestionSyncService';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import {
  advanceUntilDone,
  gatewayCalls,
  http,
  HttpResponse,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { resetFileSystem } from '@/test/helpers/fs';
import { installLlama, llamaLoads, llamaMaxLive } from '@/test/helpers/llama';
import * as suggestionReads from '@/lib/database/services/article-suggestion-reads';
import { RELEVANCE_MODEL, TEXT_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { initLlama } from 'llama.rn';
import {
  addHardFilter,
  failUnfilteredReads,
  quietLogger,
  resetForYouStore,
  scoreRow,
  seedArticles,
  seedFactWithTopic,
  settleWrites,
  suggestionRows,
} from './seed';

// The edges: llama.rn (scripted by installLlama), expo-file-system (the model file), expo-keep-awake.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(),
}));

const KEEP_AWAKE_TAG = 'mera-scoring-pass';
const mockInitLlama = initLlama as unknown as jest.Mock;

/** Six stories with nothing in common, so story grouping elects each as its own representative
 *  and the batch clears the cloud dispatch floor. */
const TITLES = [
  'Volcano erupts near Naples',
  'Central bank holds rates steady',
  'Local team wins cup final',
  'Chipmaker unveils quantum processor',
  'Floods displace thousands in Assam',
  'New museum opens in Lagos',
];
async function seedScorableStories() {
  const fact = await seedFactWithTopic('I follow chips', 'chips');
  await seedArticles(
    TITLES.map((title, i) => ({
      id: `a${i}`,
      title,
      matchedTopics: [{ topicId: fact.topicId, text: fact.topicText }],
    })),
  );
}

/** Counts how many times a refresh replaced the store's suggestion array. */
function refreshCounter() {
  let count = 0;
  const stop = useForYouStore.subscribe((state, prev) => {
    if (state.suggestions !== prev.suggestions) count++;
  });
  return { get count() { return count; }, stop };
}

/** Advance the fake clock in small steps until `cond` holds. */
async function advanceUntil(cond: () => boolean, maxMs = 20_000): Promise<void> {
  for (let t = 0; t < maxMs && !cond(); t += 50) await jest.advanceTimersByTimeAsync(50);
  if (!cond()) throw new Error('advanceUntil: condition not met');
}

const storeIds = () => useForYouStore.getState().suggestions.map((s) => s._id);

describe('SuggestionSyncService', () => {
  let logs: ReturnType<typeof quietLogger>;

  beforeEach(() => {
    logs = quietLogger();
    __resetSuggestionsRefreshThrottleForTests();
    resetForYouStore();
    useHardFilterLabelStore.getState().clear();
    useMeraProtocolStore.setState({
      processingMode: ProcessingMode.Cloud,
      modelState: 'not_downloaded',
    });
  });

  afterEach(async () => {
    // Runs before the harness's own afterEach: let fire-and-forget writes (setCounts persists feed
    // metadata) land before the clock and the DB are reset under them.
    await settleWrites();
    __resetSuggestionsRefreshThrottleForTests();
    pipeline._resetForTests();
    await disposeModel();
    useNetworkStore.setState({ isConnected: true });
    useMeraProtocolStore.setState({
      processingMode: ProcessingMode.Cloud,
      modelState: 'not_downloaded',
    });
    logs.restore();
  });

  describe('runScoringPass: cloud mode', () => {
    beforeEach(async () => {
      resetLimiter();
      resetModelFallback();
      clearAttestationCache();
      invalidateJwtCache();
      await signInFixtureAccount();
      useFakeClock('2026-10-09T09:00:00Z');
    });

    // A whole cloud scoring run (real E2EE both ways, up to 120 poll ticks): seconds of real CPU,
    // so the 5 s default fails it on a loaded machine. The budget is real time; nothing it asserts is.
    it('enqueues the unscored stories, returns 0, clears the header error, and the gateway scores them', async () => {
      await seedScorableStories();
      useForYouStore.setState({ scoringError: 'generic' });

      const result = await advanceUntilDone(runScoringPass());

      // 'running': the pipeline accepted the pass (batches in flight), so the header error clears.
      expect(result).toBe(0);
      expect(useForYouStore.getState().scoringError).toBeNull();
      expect(await pipeline.getPipelineStatus()).toBe('running');

      // Let the foreground poller drive the batch to completion against the gateway mock.
      for (let i = 0; i < 120 && (await pipeline.getPipelineStatus()) === 'running'; i++) {
        await jest.advanceTimersByTimeAsync(1000);
      }
      expect(gatewayCalls('job').map((c) => c.callId)).toContain('score:0');
      const rows = Object.values(await suggestionRows());
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row.status).not.toBe('unscored');
        expect(row.relevance).toBeGreaterThan(0.3);
      }
    }, 30_000);

    it('clears the header scoring error when the pipeline has nothing left to do (idle)', async () => {
      useForYouStore.setState({ scoringError: 'server' });

      const result = await advanceUntilDone(runScoringPass());

      expect(result).toBe(0);
      expect(await pipeline.getPipelineStatus()).toBe('idle');
      expect(useForYouStore.getState().scoringError).toBeNull();
    });

    it('sets the header scoring error, logs a warning and returns 0 when the cycle errors', async () => {
      // The run's attestation fetch fails, so the cycle reports 'error' (transient).
      server.use(
        http.get('*/api/attestation/report', () => new HttpResponse('Unauthorized', { status: 401 })),
      );
      await seedScorableStories();

      const result = await advanceUntilDone(runScoringPass());

      expect(result).toBe(0);
      expect(useForYouStore.getState().scoringError).toBe('server');
      expect(logs.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('cloud inference cycle returned error'),
        expect.objectContaining({ level: 'warning' }),
      );
    });

    it('classifies the cycle error as offline when the device has no connection', async () => {
      server.use(
        http.get('*/api/attestation/report', () => new HttpResponse('Unauthorized', { status: 401 })),
      );
      await seedScorableStories();
      useNetworkStore.setState({ isConnected: false });

      await advanceUntilDone(runScoringPass());

      expect(useForYouStore.getState().scoringError).toBe('offline');
    });

    // Not ported: "rethrows exceptions from runBackgroundCycle and sets the header error". The old
    // test mocked runBackgroundCycle to reject, but the real one catches everything inside its
    // try/catch and reports 'error' (above), so the `catch` around it in runScoringPass cannot be
    // reached at this seam. See the report: dead branch.
  });

  describe('runScoringPass: on-device mode', () => {
    beforeEach(() => {
      useFakeClock('2026-10-09T09:00:00Z');
      resetFileSystem();
      installLlama(['A short note.']);
      useMeraProtocolStore.setState({
        processingMode: ProcessingMode.OnDevice,
        modelState: 'ready',
      });
    });

    it('keeps the screen awake for the pass and releases it afterwards', async () => {
      await advanceUntilDone(runScoringPass());

      expect(activateKeepAwakeAsync).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
      expect(deactivateKeepAwake).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
    });

    it('scores every unscored row in batches of the given size and returns the count', async () => {
      await seedScorableStories();
      const processed = new Set<number>();
      const stop = useForYouStore.subscribe((s) => processed.add(s.deviceProcessedCount));

      const scored = await advanceUntilDone(runScoringPass(2));
      stop();

      expect(scored).toBe(6);
      // Batches of 2: progress passes through 2 and 4 (the default batch of 20 would jump 0 -> 6).
      expect([...processed]).toEqual(expect.arrayContaining([0, 2, 4, 6]));
      const rows = Object.values(await suggestionRows());
      expect(rows).toHaveLength(6);
      expect(rows.map((r) => r.status)).not.toContain('unscored');
      // The final refresh landed: the store shows the scored rows and no unscored remainder.
      const stored = useForYouStore.getState().suggestions;
      expect(stored).toHaveLength(6);
      expect(stored.map((s) => s.status)).not.toContain('unscored');
      expect(useForYouStore.getState().unscoredCount).toBe(0);
    });

    it('does not preload a model: nothing to score loads nothing and leaves the model state alone', async () => {
      useMeraProtocolStore.setState({ modelState: 'downloaded' });

      await advanceUntilDone(runScoringPass());

      expect(mockInitLlama).not.toHaveBeenCalled();
      expect(useMeraProtocolStore.getState().modelState).toBe('downloaded');
    });

    it('loads each model once per sync, Kev for scoring then the text model for notes, never two at once', async () => {
      await seedScorableStories();

      await advanceUntilDone(runScoringPass(2));

      expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId, TEXT_MODEL.modelId]);
      expect(llamaMaxLive()).toBe(1);
    });

    it('does not load the model when it is already ready and there is nothing to score', async () => {
      await advanceUntilDone(runScoringPass());

      expect(mockInitLlama).not.toHaveBeenCalled();
    });

    it('raises the device-processing flag from 0, reports progress, and marks the run finished', async () => {
      await seedScorableStories();
      const startedAt = Date.now();
      const seen: { processing: boolean; processed: number; total: number }[] = [];
      const stop = useForYouStore.subscribe((s) =>
        seen.push({
          processing: s.isDeviceProcessing,
          processed: s.deviceProcessedCount,
          total: s.deviceTotalCount,
        }),
      );

      await advanceUntilDone(runScoringPass());
      stop();

      // startDeviceProcessing(0) first, then onProgress(0, 6) ... onProgress(6, 6).
      expect(seen[0]).toEqual({ processing: true, processed: 0, total: 0 });
      expect(seen).toContainEqual({ processing: true, processed: 0, total: 6 });
      expect(seen).toContainEqual({ processing: true, processed: 6, total: 6 });
      const final = useForYouStore.getState();
      expect(final.isDeviceProcessing).toBe(false);
      expect(final.lastProcessingRunFinishedAt).toBeGreaterThanOrEqual(startedAt);
      expect(final.lastProcessingRunFinishedAt).toBeLessThanOrEqual(Date.now());
    });

    it('on failure: rethrows, captures, lowers the flag and releases the screen, without marking the run finished', async () => {
      const err = new Error('on-device error');
      jest.spyOn(suggestionReads, 'countUnscoredSuggestions').mockRejectedValueOnce(err);

      await expect(advanceUntilDone(runScoringPass())).rejects.toThrow('on-device error');

      expect(logs.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          tags: expect.objectContaining({ service: 'SuggestionSyncService', method: 'runScoringPass' }),
        }),
      );
      const state = useForYouStore.getState();
      expect(state.isDeviceProcessing).toBe(false);
      expect(state.lastProcessingRunFinishedAt).toBeNull();
      expect(deactivateKeepAwake).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
    });

    it('a failing store refresh during scoring is captured and does not fail the pass', async () => {
      await seedScorableStories();
      const loadErr = new Error('db read error');
      const restore = failUnfilteredReads('article_suggestions', loadErr);

      let scored: number;
      try {
        scored = await advanceUntilDone(runScoringPass());
      } finally {
        restore();
      }

      expect(scored).toBe(6);
      expect(logs.captureException).toHaveBeenCalledWith(
        loadErr,
        expect.objectContaining({
          tags: expect.objectContaining({ service: 'SuggestionSyncService' }),
        }),
      );
    });
  });

  describe('refreshSuggestionsInStoreUnsafe', () => {
    it('loads the stored suggestions into the store', async () => {
      await seedArticles([{ id: 'a' }, { id: 'b' }]);

      await refreshSuggestionsInStoreUnsafe();

      expect(storeIds().sort()).toEqual(['a', 'b']);
    });

    it('sorts by relevance descending, scored before unscored', async () => {
      await seedArticles([{ id: 'low' }, { id: 'high' }, { id: 'unscored' }]);
      await scoreRow('low', 0.3);
      await scoreRow('high', 0.9);

      await refreshSuggestionsInStoreUnsafe();

      expect(storeIds()).toEqual(['high', 'low', 'unscored']);
    });

    it('counts unscored and relevant articles and keeps the server article count', async () => {
      await seedArticles([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
      await scoreRow('a', 0.9);
      await scoreRow('b', 0.3); // exactly on the display threshold: not above it
      await scoreRow('c', 0.1); // below it
      // d stays unscored
      useForYouStore.setState({ articleCount: 10 });

      await refreshSuggestionsInStoreUnsafe();

      const state = useForYouStore.getState();
      expect(state.unscoredCount).toBe(1);
      expect(state.articleCount).toBe(10);
      expect(state.relevantArticleCount).toBe(1); // only relevance > 0.3
    });

    it('keeps two unscored rows (both sort last) and counts both as unscored', async () => {
      await seedArticles([{ id: 'a' }, { id: 'b' }]);

      await refreshSuggestionsInStoreUnsafe();

      const state = useForYouStore.getState();
      expect(state.suggestions).toHaveLength(2);
      expect(state.suggestions.every((s) => s.status === 'unscored')).toBe(true);
      expect(state.unscoredCount).toBe(2);
    });

    it('republishes the filtered-but-shown headline labels with every refresh', async () => {
      await seedArticles([{ id: 'head', title: 'Nvidia ships a GPU', headlineScope: 'GLOBAL' }]);
      await addHardFilter({ keyword: 'nvidia' });

      await refreshSuggestionsInStoreUnsafe();

      expect(useHardFilterLabelStore.getState().labels).toEqual({ head: 'nvidia' });
    });
  });

  describe('requestSuggestionsRefresh / flushSuggestionsRefresh: throttle', () => {
    let refreshes: ReturnType<typeof refreshCounter>;
    beforeEach(() => {
      useFakeClock('2026-10-09T09:00:00Z');
      refreshes = refreshCounter();
    });
    afterEach(() => refreshes.stop());

    it('runs the first (leading) call immediately', async () => {
      await seedArticles([{ id: 'a' }]);

      await requestSuggestionsRefresh();

      expect(refreshes.count).toBe(1);
      expect(storeIds()).toEqual(['a']);
    });

    it('coalesces multiple in-window calls into a single trailing execution', async () => {
      await requestSuggestionsRefresh(); // leading, runs now
      expect(refreshes.count).toBe(1);
      await seedArticles([{ id: 'late' }]);

      // Three more inside the window: still pending, one trailing pass, not three.
      void requestSuggestionsRefresh();
      void requestSuggestionsRefresh();
      void requestSuggestionsRefresh();
      expect(refreshes.count).toBe(1);
      expect(storeIds()).toEqual([]);

      await jest.advanceTimersByTimeAsync(REFRESH_MIN_INTERVAL_MS);
      await advanceUntil(() => refreshes.count >= 2);
      await jest.advanceTimersByTimeAsync(REFRESH_MIN_INTERVAL_MS * 2);

      expect(refreshes.count).toBe(2);
      expect(storeIds()).toEqual(['late']);
    });

    it('flush cancels the pending trailing timer and refreshes immediately', async () => {
      await requestSuggestionsRefresh(); // leading
      void requestSuggestionsRefresh(); // schedules the trailing pass
      expect(refreshes.count).toBe(1);

      await flushSuggestionsRefresh(); // runs the pending work now
      expect(refreshes.count).toBe(2);

      // The cancelled timer must not fire an extra refresh.
      await jest.advanceTimersByTimeAsync(REFRESH_MIN_INTERVAL_MS * 2);
      expect(refreshes.count).toBe(2);
    });

    it('flush is a no-op when nothing is pending', async () => {
      await requestSuggestionsRefresh(); // leading, nothing scheduled after
      expect(refreshes.count).toBe(1);

      await flushSuggestionsRefresh();

      expect(refreshes.count).toBe(1);
    });

    it('a request after the window has elapsed is a new leading call', async () => {
      await requestSuggestionsRefresh();
      await jest.advanceTimersByTimeAsync(REFRESH_MIN_INTERVAL_MS);

      await requestSuggestionsRefresh();

      expect(refreshes.count).toBe(2);
    });

    it('flushes during an in-flight refresh collapse into exactly one extra pass', async () => {
      const first = requestSuggestionsRefresh(); // leading, in flight
      const flushA = flushSuggestionsRefresh();
      const flushB = flushSuggestionsRefresh();

      await Promise.all([first, flushA, flushB]);

      expect(refreshes.count).toBe(2);
    });

    it('never rejects when the underlying refresh throws; it logs instead', async () => {
      const err = new Error('db read error');
      const restore = failUnfilteredReads('article_suggestions', err);

      try {
        await expect(requestSuggestionsRefresh()).resolves.toBeUndefined();
      } finally {
        restore();
      }

      expect(logs.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          tags: expect.objectContaining({ service: 'SuggestionSyncService' }),
        }),
      );
    });
  });

  describe('identity-preserving merge', () => {
    const rowOf = (id: string) => useForYouStore.getState().suggestions.find((s) => s._id === id)!;

    it('reuses the previous object reference when all display fields are unchanged', async () => {
      await seedArticles([{ id: 'x' }]);
      await refreshSuggestionsInStoreUnsafe();
      const prev = rowOf('x');

      await refreshSuggestionsInStoreUnsafe();

      expect(rowOf('x')).toBe(prev);
    });

    it('uses a fresh object when a scalar display field changed, and keeps the untouched row', async () => {
      await seedArticles([{ id: 'x' }, { id: 'y' }]);
      await refreshSuggestionsInStoreUnsafe();
      const prevX = rowOf('x');
      const prevY = rowOf('y');
      await scoreRow('x', 0.9);

      await refreshSuggestionsInStoreUnsafe();

      expect(rowOf('x')).not.toBe(prevX);
      expect(rowOf('x').relevance).toBe(0.9);
      expect(rowOf('y')).toBe(prevY);
    });

    it('detects a change in the nested cluster signature (stableClusterId)', async () => {
      await seedArticles([{ id: 'x', clusterId: 'c1', stableClusterId: 's1' }]);
      await refreshSuggestionsInStoreUnsafe();
      const prev = rowOf('x');
      await seedArticles([{ id: 'x', clusterId: 'c1', stableClusterId: 's2' }]); // re-sync of the same article

      await refreshSuggestionsInStoreUnsafe();

      expect(rowOf('x')).not.toBe(prev);
      expect(rowOf('x').clusters?.[0].stableClusterId).toBe('s2');
    });

    it('detects a change in the matched-topics signature', async () => {
      await seedArticles([{ id: 'x', matchedTopics: [] }]);
      await refreshSuggestionsInStoreUnsafe();
      const prev = rowOf('x');
      // A later sync heals the empty matched topics of the stored row.
      await seedArticles([{ id: 'x', matchedTopics: [{ topicId: 't1', text: 'ai' }] }]);

      await refreshSuggestionsInStoreUnsafe();

      expect(rowOf('x')).not.toBe(prev);
      expect(rowOf('x').matchedTopics).toEqual([{ topicId: 't1', text: 'ai' }]);
    });
  });
});
