// FeedSyncMachine in BACKGROUND mode (`start('', ctx, { background: hooks })`, the `mera-background`
// OS task): nobody is watching, so no wake lock, no status, no toast, no offline pause, no
// foreground enqueue or flush, and the bounded background submit stands in for the scoring step.
// The hooks are assembled from the real allowance ledger, freshness shaping and scoring submit.
// Replaces the background-mode block of lib/scheduler/feed-sync/__tests__/FeedSyncMachine.test.ts.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import database from '@/lib/database';
import { getSetting } from '@/lib/database/services/setting-service';
import { BG_ARTICLES_CHARGED_PREFIX, BG_QUOTA_EXHAUSTED_DAY_KEY } from '@/lib/background/bg-refresh-settings';
import { utcDayKey } from '@/lib/background/background-allowance';
import logger from '@/lib/logger';
import * as persistence from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import { toastManager } from '@/lib/toast-manager';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, assertNoGatewayViolations, gatewayCalls, graphql, HttpResponse, server } from '@/test/helpers';
import {
  cleanupFeedSync,
  makeCtx,
  resetFeedSyncMemory,
  resetScoringWorld,
  rowsById,
  seedInterest,
  serveHydrate,
  servePersona,
  spyOnExport,
} from '../steps/support';
import {
  backgroundHooks,
  buildRunningPipeline,
  currentRunId,
  feedSyncMachine,
  gate,
  fetchStep,
  keepAwake,
  loadMachineSnapshot,
  oid,
  recordMachine,
  watchScoring,
  scoreEntries,
  settleMachine,
  startMachine,
  watchNetworkSubscriptions,
} from './support';
import { COLLECT_WINDOW_MS } from '@/lib/algorithms/scoring-pipeline-policy';

jest.setTimeout(60_000);

describe('FeedSyncMachine in background mode', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
    assertNoGatewayViolations();
  });

  const store = () => useForYouStore.getState();
    const captured = () => (logger.captureException as jest.Mock).mock.calls;
  const HOUR = 3_600_000;

  /** Fresh server ids (inserted a moment ago) the topic matches, with the interest seeded. */
  async function serveFresh(count: number, over: { stale?: number } = {}) {
    const fresh = Array.from({ length: count }, (_, i) => oid(i + 1));
    const old = Array.from({ length: over.stale ?? 0 }, (_, i) => oid(1000 + i, Date.now() - 7 * HOUR));
    await seedInterest('I follow racing', ['formula 1']);
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'formula 1': [...fresh, ...old] } }), ...served.handlers);
    return { fresh, old, served };
  }

  const run = (hooks: ReturnType<typeof backgroundHooks>, t = makeCtx()) =>
    advanceUntilDone(startMachine(t, { background: hooks.hooks }));

  describe('a background run with new articles', () => {
    it('hydrates, persists and submits the eligible ids through the hook, never through the scoring step', async () => {
      const { fresh } = await serveFresh(6);
      const hooks = backgroundHooks();

      await run(hooks);

      expect([...(await rowsById()).keys()].sort()).toEqual([...fresh].sort());
      expect(hooks.calls.submitted).toHaveLength(1);
      expect([...hooks.calls.submitted[0]].sort()).toEqual([...fresh].sort());
      expect(scoreEntries).toEqual([]);
      expect(gatewayCalls('job').length).toBeGreaterThan(0); // the bounded submit reached the gateway
      expect(feedSyncMachine.state).toBe('done');
    });

    it('enqueues nothing through the foreground path: the gateway has seen no job when the hook is called', async () => {
      await serveFresh(6);
      const hooks = backgroundHooks();

      await run(hooks);

      expect(hooks.calls.postsAtSubmit).toEqual([0]);
    });

    it('keeps the allowance ledger: reserved before the request, corrected to what the server granted', async () => {
      await serveFresh(6);
      const hooks = backgroundHooks();

      await run(hooks);

      expect(await getSetting(BG_ARTICLES_CHARGED_PREFIX + utcDayKey(hooks.now))).toBe('6');
    });

    it('shapes the diff first: an id inserted more than 6h ago is never hydrated', async () => {
      const { fresh, old, served } = await serveFresh(3, { stale: 2 });
      const hooks = backgroundHooks();

      await run(hooks);

      const asked = served.stats.requests.flatMap((r) => r.ids);
      expect(asked.sort()).toEqual([...fresh].sort());
      expect(asked.some((id) => old.includes(id))).toBe(false);
      expect(await getSetting(BG_ARTICLES_CHARGED_PREFIX + utcDayKey(hooks.now))).toBe('3');
    });

    it('routes the per-chunk store refresh through the hook, and flushes nothing itself', async () => {
      await serveFresh(6);
      const hooks = backgroundHooks();

      await run(hooks);

      expect(hooks.calls.refresh).toBeGreaterThan(0);
      expect(store().suggestions).toEqual([]); // the foreground refresh and the tail flush never ran
    });

    it('fetches and persists only when there is no submit hook (on-device mode)', async () => {
      const { fresh } = await serveFresh(4);
      const hooks = backgroundHooks({ submit: false });

      await run(hooks);

      expect((await rowsById()).size).toBe(fresh.length);
      expect(gatewayCalls('job')).toEqual([]);
      expect(scoreEntries).toEqual([]);
    });
  });

  describe('a background run is silent', () => {
    it('takes no wake lock, publishes no status, shows no toast and writes no inbox row', async () => {
      await serveFresh(4);
      const notified = spyOnExport(toastManager, 'showNotifiedToast').mockResolvedValue(undefined as never);
      const rec = recordMachine();

      await run(backgroundHooks());

      expect(keepAwake.taken()).toBe(0);
      expect(keepAwake.released()).toBe(0);
      expect(rec.published).toEqual([]);
      expect(store().syncStatusMessage).toBeNull();
      expect(notified).not.toHaveBeenCalled();
      expect(await database.get('notifications').query().fetchCount()).toBe(0);
      rec.stop();
    });

    it('subscribes to no network events', async () => {
      await serveFresh(3);
      const subscriptions = watchNetworkSubscriptions();

      await run(backgroundHooks());

      expect(subscriptions.calls()).toBe(0);
    });

    it('does not clear the scoring error a reader may be looking at', async () => {
      await serveFresh(3);
      store().setScoringError('server');

      await run(backgroundHooks());

      expect(store().scoringError).toBe('server');
    });
  });

  describe('a background run that fails', () => {
    it('fails silently: the cause reaches the caller, with no status, no toast and no failed snapshot', async () => {
      await serveFresh(3);
      server.use(graphql.query('GetArticleIdsForPersona', () => HttpResponse.error()));
      const notified = spyOnExport(toastManager, 'showNotifiedToast').mockResolvedValue(undefined as never);

      await expect(run(backgroundHooks())).rejects.toBeDefined();

      expect(store().syncStatusMessage).toBeNull();
      expect(notified).not.toHaveBeenCalled();
      expect(await loadMachineSnapshot()).not.toEqual(expect.objectContaining({ state: 'failed' }));
      expect(feedSyncMachine.state).toBe('idle');
    });

    it('a lost link fails the run rather than parking it', async () => {
      await serveFresh(3);
      const held = gate();
      const fetch = fetchStep().hold(held.held, { fail: true });
      const running = startMachine(makeCtx(), { background: backgroundHooks().hooks });
      const outcome = running.then(() => 'resolved', () => 'rejected');
      await fetch.reached(1);

      useNetworkStore.getState().setIsConnected(false);
      expect(feedSyncMachine.state).toBe('fetching-topic-ids'); // not paused-offline
      held.release();

      await expect(advanceUntilDone(outcome)).resolves.toBe('rejected');
      expect(store().syncStatusMessage).toBeNull();
    });

    it('no topics at all: ends quietly, publishes nothing, and is not a failure', async () => {
      const rec = recordMachine();

      await expect(run(backgroundHooks())).resolves.toBeUndefined();

      expect(rec.published).toEqual([]);
      expect(store().syncStatusMessage).toBeNull();
      expect(feedSyncMachine.state).toBe('idle');
      expect(captured()).toEqual([]);
      rec.stop();
    });

    it('a daily-limit clip whose snapshot cannot be cleared still ends quietly', async () => {
      await serveFresh(3);
      server.use(...serveHydrate({ respond: () => ({ articles: [], dailyLimitReached: true }) }).handlers);
      spyOnExport(persistence, 'clearMachineSnapshot').mockRejectedValueOnce(new Error('snap clear error'));

      await expect(run(backgroundHooks())).resolves.toBeUndefined();

      expect(feedSyncMachine.state).toBe('idle');
    });

    it('a full daily-limit clip is recorded for the allowance, quietly: no status, no notice', async () => {
      const { fresh } = await serveFresh(4);
      server.use(...serveHydrate({ respond: () => ({ articles: [], dailyLimitReached: true }) }).handlers);
      const hooks = backgroundHooks();
      const rec = recordMachine();

      await expect(run(hooks)).resolves.toBeUndefined();

      expect(await getSetting(BG_QUOTA_EXHAUSTED_DAY_KEY)).toBe(utcDayKey(hooks.now));
      expect(rec.published).toEqual([]);
      expect(feedSyncMachine.state).toBe('idle');
      expect(await loadMachineSnapshot()).toBeNull();
      expect(await rowsById()).toEqual(new Map());
      expect(captured()).toEqual([]);
      expect(fresh).toHaveLength(4);
      rec.stop();
    });
  });

  describe('a background run beside a scoring run in flight', () => {
    it('never aborts it, even when it is wedged, and does not suppress its own submit', async () => {
      const runId = await buildRunningPipeline();
      jest.setSystemTime(Date.now() + COLLECT_WINDOW_MS + 30 * 60_000); // wedged for a foreground run
      const { fresh } = await serveFresh(3);
      const hooks = backgroundHooks({ now: Date.now() });

      await run(hooks);

      expect(await currentRunId()).toBe(runId);
      expect(hooks.calls.submitted).toHaveLength(1);
      expect(fresh.length).toBe(3);
    });
  });

  describe('a foreground start beside a background run', () => {
    it('joins a live background run: one persona request', async () => {
      await serveFresh(3);
      const held = gate();
      const fetch = fetchStep().hold(held.held);
      startMachine(makeCtx(), { background: backgroundHooks().hooks });
      await fetch.reached(1);

      startMachine(makeCtx(), { personaId: 'persona-1' });
      await advanceUntilDone(Promise.resolve());

      expect(fetch.calls()).toBe(1);
    });

    it('does NOT join a background run whose deadline already aborted it: it starts its own', async () => {
      await serveFresh(3);
      const heldBackground = gate();
      const fetch = fetchStep().hold(heldBackground.held, { nth: 1 });
      const bg = makeCtx();
      startMachine(bg, { background: backgroundHooks().hooks });
      await fetch.reached(1);
      bg.abort(); // the OS task's 60s deadline fired

      const foreground = startMachine(makeCtx(), { personaId: 'persona-1' });
      await advanceUntilDone(foreground);

      expect(fetch.calls()).toBe(2); // the hanging background run's and its own
      expect(scoreEntries).toHaveLength(1);
      expect(feedSyncMachine.state).toBe('done');
    });
  });
});
