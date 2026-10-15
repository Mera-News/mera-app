// Step (b) drives the ordinary FeedSyncMachine in BACKGROUND mode with the hooks
// `runBackgroundFeedSync` builds. This file pins what those hooks make the machine do: silence, the
// bounded submit in place of the foreground scoring step, on-device fetch-and-persist, the deadline,
// and the store refresh that is owed to whoever opens the app next.
//
// Replaces lib/background/__tests__/background-feed-sync.test.ts ("the run" and "the store refresh
// owed" blocks) and answers for the hooks data-U6b assembled by hand in
// feed-sync/machine/support.ts. Those hooks were captured from a mocked machine and called by hand;
// here the real machine calls the real ones.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { BG_MAX_BATCHES, isRefreshOwed, shapeBackgroundDiff } from '@/lib/background/background-feed-sync';
import database from '@/lib/database';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { advanceUntil, advanceUntilDone, advanceUntilSettled, gatewayCalls, graphql, HttpResponse, mockGqlError, setAppState } from '@/test/helpers';

import { useNetworkStore } from '@/lib/stores/network-store';

import { feedSyncMachine, fetchStep, loadMachineSnapshot, watchNetworkSubscriptions } from '../feed-sync/machine/support';
import { scoredIds } from '../feed-sync/steps/support';
import {
  HOUR,
  NOW,
  breadcrumbs,
  hold,
  keepAwake,
  oid,
  recordMachine,
  rowsById,
  runFetch,
  scoreEntries,
  sentryEvents,
  server,
  serveFresh,
  spyOnExport,
  toastsShown,
  wakeCleanup,
  wakeWorld,
  watchScoring,
} from './support';

jest.setTimeout(60_000);

beforeEach(async () => {
  await wakeWorld({ afterBoundary: true });
  watchScoring();
});
afterEach(wakeCleanup);

const store = () => useForYouStore.getState();

describe('a background run submits through the bounded hook', () => {
  it('hands the persisted ids to the gateway through the background submit, never through the scoring step', async () => {
    const submit = spyOnExport(pipeline, 'submitScoringForBackground');
    const { fresh } = await serveFresh(6);

    await advanceUntilDone(runFetch());

    expect([...(await rowsById()).keys()].sort()).toEqual([...fresh].sort());
    expect(submit).toHaveBeenCalledTimes(1);
    const [args] = submit.mock.calls[0];
    expect(args.articleIds.slice().sort()).toEqual([...fresh].sort());
    expect(args.maxBatches).toBe(BG_MAX_BATCHES);
    expect(args.deadlineAt).toBe(NOW + 60_000);
    expect(gatewayCalls('job').length).toBeGreaterThan(0); // the async submit reached the gateway
    expect([...new Set(scoredIds())].sort()).toEqual([...fresh].sort());
    expect(scoreEntries).toEqual([]); // stepScore (which polls for results) never ran
  });

  it('in on-device mode fetches and persists only: the submit is not called and nothing is sent', async () => {
    const submit = spyOnExport(pipeline, 'submitScoringForBackground');
    useDatabaseStore.setState({ ready: true }); // the boot hydrated: the store keeps its mode
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const { fresh } = await serveFresh(4);

    const out = await advanceUntilDone(runFetch());

    expect(out.stoppedBy).toBe('done');
    expect((await rowsById()).size).toBe(fresh.length);
    expect(submit).not.toHaveBeenCalled();
    expect(gatewayCalls('job')).toEqual([]);
    expect(scoreEntries).toEqual([]);
  });
});

describe('a background run is silent', () => {
  it('takes no wake lock, publishes no status, shows no toast, writes no inbox row, subscribes to no network event', async () => {
    await serveFresh(4);
    const rec = recordMachine();
    const subscriptions = watchNetworkSubscriptions();

    await advanceUntilDone(runFetch());

    expect(keepAwake.taken()).toBe(0);
    expect(keepAwake.released()).toBe(0);
    expect(rec.published).toEqual([]);
    expect(store().syncStatusMessage).toBeNull();
    expect(toastsShown()).toEqual([]);
    expect(await database.get('notifications').query().fetchCount()).toBe(0);
    expect(subscriptions.calls()).toBe(0);
    expect(sentryEvents()).toEqual([]);
    rec.stop();
  });

  it('does not clear a scoring error the reader may be looking at', async () => {
    await serveFresh(3);
    store().setScoringError('server');

    await advanceUntilDone(runFetch());

    expect(store().scoringError).toBe('server');
  });
});

describe('a run that fails', () => {
  it("returns 'error' for a failed request, with a breadcrumb: no status and no failed snapshot", async () => {
    await serveFresh(3);
    server.use(graphql.query('GetArticleIdsForPersona', () => HttpResponse.error()));

    const out = await advanceUntilDone(runFetch());

    expect(out.stoppedBy).toBe('error');
    expect(breadcrumbs()).toContain('bg-feed-sync: run failed');
    expect(store().syncStatusMessage).toBeNull();
    // (The error link still calls toastManager.showNetworkError; a headless wake has no toast
    // instance to render it. Not asserted.)
    expect(feedSyncMachine.state).toBe('idle');
    expect(await loadMachineSnapshot()).not.toEqual(expect.objectContaining({ state: 'failed' }));
  });

  // DA37 (DATA-U15-3). A background run publishes no status. The Apollo error link paints the
  // feed-wide 'sync failed' banner for a GraphQL error only while the app is foregrounded, so the
  // reader does not open the app to a failure banner for a fetch they never started.
  it('DA37: a GraphQL error during a background fetch leaves no status for the reader to find', async () => {
    await serveFresh(3);
    server.use(mockGqlError('GetArticleIdsForPersona', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));

    await advanceUntilDone(runFetch());

    expect(store().syncStatusMessage).toBeNull();
  });

  it('a lost link fails the run rather than parking it', async () => {
    await serveFresh(3);
    const held = hold();
    const fetch = fetchStep().hold(held.held, { fail: true });
    let outcome: unknown;
    void runFetch().then((o) => (outcome = o));
    await fetch.reached(1);

    useNetworkStore.getState().setIsConnected(false);
    expect(feedSyncMachine.state).toBe('fetching-topic-ids'); // not paused-offline
    held.release();
    await advanceUntil(() => outcome !== undefined);

    expect(outcome).toMatchObject({ stoppedBy: 'error' });
    expect(store().syncStatusMessage).toBeNull();
    useNetworkStore.getState().setIsConnected(true);
  });

  it('returns at the deadline even while a request is still on the wire, and the machine unwinds afterwards', async () => {
    const wire = hold();
    const { served } = await serveFresh(3, { hydrate: { gate: () => wire.held } });
    let outcome: unknown;
    void runFetch({ deadlineAt: NOW + 5_000 }).then((o) => (outcome = o));
    await advanceUntil(() => served.stats.inFlight > 0, 4_000); // the hydrate request is on the wire

    await jest.advanceTimersByTimeAsync(NOW + 5_000 - 1 - Date.now());
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await advanceUntilDone(Promise.resolve());

    expect(outcome).toEqual({ stoppedBy: 'deadline', fetchBudget: 50 });
    wire.release();
    await advanceUntilSettled();
  });

  it('a request that fails after the deadline is not reported as a failure: the deadline already owns the run', async () => {
    await serveFresh(3);
    const held = hold();
    const fetch = fetchStep().hold(held.held, { fail: true });
    let outcome: unknown;
    void runFetch({ deadlineAt: NOW + 5_000 }).then((o) => (outcome = o));
    await fetch.reached(1);

    await jest.advanceTimersByTimeAsync(NOW + 5_000 - Date.now());
    await advanceUntilDone(Promise.resolve());
    expect(outcome).toMatchObject({ stoppedBy: 'deadline' });
    held.release(); // the step now fails, into a signal that has already aborted
    await advanceUntilSettled();

    expect(breadcrumbs()).not.toContain('bg-feed-sync: run failed');
  });
});

describe('the store refresh is owed to whoever is looking', () => {
  it('is owed, not paid, while the app stays in the background', async () => {
    await serveFresh(3);

    await advanceUntilDone(runFetch());

    expect(isRefreshOwed()).toBe(true);
    expect(store().suggestions).toEqual([]);
  });

  it('is paid on the next activation', async () => {
    const { fresh } = await serveFresh(3);
    await advanceUntilDone(runFetch());
    expect(isRefreshOwed()).toBe(true);

    setAppState('active');
    await advanceUntil(() => store().suggestions.length === fresh.length);

    expect(isRefreshOwed()).toBe(false);
  });

  it('is paid at the end of the run when the reader had the app open throughout', async () => {
    setAppState('active');
    const { fresh } = await serveFresh(3);

    await advanceUntilDone(runFetch());
    await advanceUntil(() => store().suggestions.length === fresh.length);

    expect(isRefreshOwed()).toBe(false);
  });

  it('stays owed through an activation that lands while the run is still saving rows, and is paid when it ends', async () => {
    // 30 ids make two chunks of 25 and 5; the second answers only when released.
    const second = hold();
    const { fresh } = await serveFresh(30, { hydrate: { gate: ({ n }) => (n === 2 ? second.held : undefined) } });
    const running = runFetch();
    await advanceUntil(() => isRefreshOwed()); // the first chunk landed and asked for a refresh

    setAppState('active');
    await jest.advanceTimersByTimeAsync(2_000);

    expect(isRefreshOwed()).toBe(true); // a run still saving rows never clears it
    second.release();
    await advanceUntilDone(running);
    await advanceUntil(() => store().suggestions.length === fresh.length);
    expect(isRefreshOwed()).toBe(false);
  });
});

describe('shapeBackgroundDiff on a diff without the persona shape', () => {
  const diffOf = (missingIds: string[]) => ({ serverArticleIds: missingIds, articleToTopicTexts: new Map(), missingIds });

  it('falls back to the missing ids for the persona ids, and to no story ids', () => {
    const fresh = oid(1, NOW - HOUR);
    const old = oid(2, NOW - 7 * HOUR);

    const shaped = shapeBackgroundDiff(diffOf([old, fresh]), NOW, 50);

    expect(shaped.personaIds).toEqual([fresh]);
    expect(shaped.storyIds).toEqual([]);
    expect(shaped.missingIds).toEqual([fresh]);
  });
});
