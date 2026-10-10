// The data-cleanup task, registered with the REAL AppScheduler singleton and run by its tick, its
// foreground path and `trigger`. The sweep runs over real rows in the in-memory DB, seeded through
// the app's own services at ages just inside and just outside each TTL. Only the clock and AppState
// are faked.
//
// Replaces lib/scheduler/tasks/__tests__/data-cleanup-task.test.ts (22 `it`). The old suite mocked the
// scheduler and every service, so it asserted call order and cutoff arguments; this one asserts what is
// left in the tables.
import '@/lib/scheduler/tasks/data-cleanup-task';

import database from '@/lib/database';
import { addFact } from '@/lib/database/services/fact-service';
import { deleteSuggestionsByServerIds } from '@/lib/database/services/article-suggestion-lifecycle';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { upsertFactCheck, listFactChecks } from '@/lib/database/services/fact-check-record-service';
import { getAll as getNotifications, notify } from '@/lib/database/services/notification-service';
import { keepArticleForFactCheck, saveStandaloneArticle } from '@/lib/database/services/saved-article-suggestion-service';
import { getAll as getImpressions, recordOpen } from '@/lib/database/services/story-impression-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { __setJitterSeedForTests, jitterFactor, jitteredInterval } from '@/lib/scheduler/jitter';
import { createJob, markCompleted, markFailed } from '@/lib/scheduler/scheduler-persistence';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { refreshSuggestionsInStoreUnsafe } from '@/lib/services/SuggestionSyncService';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { trackStoryWithProposal } from '@/lib/tracking/track-actions';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { advanceUntil, advanceUntilDone, setAppState, useFakeClock, useStrictClock } from '@/test/helpers';
import { failTableQuery, landSuggestion, landSuggestions, originsById, restoreFaults } from './support';

const NAME = 'data-cleanup';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

const resetStore = (store: unknown): void =>
  (store as { setState(s: unknown, replace: true): void; getInitialState(): unknown }).setState(
    (store as { getInitialState(): unknown }).getInitialState(),
    true,
  );

const registered = (): TaskDefinition<unknown> =>
  (AppScheduler as unknown as { tasks: Map<string, TaskDefinition<unknown>> }).tasks.get(NAME)!;

let info: jest.SpyInstance;
const logged = (): string[] =>
  info.mock.calls.filter((c) => c[0] === '[Info]').map((c) => String(c[1])).filter((m) => m.startsWith(`[${NAME}]`));

/** A synthetic task that DOES declare the foreground trigger: proves a foreground event fired. */
let controlRuns = 0;
AppScheduler.register({
  name: 'control-foreground',
  displayName: 'Control',
  frequency: 0,
  triggers: ['app-foreground'],
  handler: async () => {
    controlRuns += 1;
  },
});

beforeEach(() => {
  controlRuns = 0;
  AppScheduler.dispose();
  AppScheduler.clearFailure(NAME);
  AppScheduler.resumeTask('control-foreground');
  __setJitterSeedForTests(0.5);
  setAppState('active');
  for (const store of [useSchedulerStore, useDatabaseStore, useNetworkStore, useUserStore, useForYouStore]) resetStore(store);
  useNetworkStore.setState({ isConnected: true });
  useDatabaseStore.getState().setReady(true);
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  AppScheduler.dispose();
  AppScheduler.pauseTask('control-foreground');
  restoreFaults();
});

const lastRun = () => useSchedulerStore.getState().getLastRun(NAME);

describe('registration', () => {
  it('is a daily, exclusive, two-attempt sweep with no triggers and exactly two conditions', () => {
    const def = registered();
    expect(def).toMatchObject({
      name: NAME,
      displayName: 'Data Cleanup',
      frequency: DAY,
      triggers: [],
      exclusive: true,
      maxAttempts: 2,
      timeout: 30_000,
    });
    // a COUNT: an added condition (a tier gate, a network gate) must fail here
    expect(def.conditions!.map((c) => c.type)).toEqual(['db-ready', 'custom']);
  });
});

describe('when the scheduler runs it', () => {
  beforeEach(() => useStrictClock(NOW));

  const init = () => advanceUntilDone(AppScheduler.init());

  it('runs on the first tick of a fresh install once the database is ready', async () => {
    await init();
    await advanceUntil(() => lastRun() !== null, 30_000);
    expect(lastRun()).toBeGreaterThanOrEqual(NOW);
  });

  it('waits for the database, and then runs on the next tick', async () => {
    useDatabaseStore.getState().setReady(false);
    await init();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lastRun()).toBeNull();

    useDatabaseStore.getState().setReady(true);
    await advanceUntil(() => lastRun() !== null, 10_000);
  });

  it('defers to a running feed sync, and fires on the first tick after it ends', async () => {
    useSchedulerStore.getState().reserveTask('feed-sync');
    await init();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lastRun()).toBeNull();

    useSchedulerStore.getState().clearTaskReservation('feed-sync');
    await advanceUntil(() => lastRun() !== null, 10_000);
  });

  it('needs no network and no signed-in user', async () => {
    useNetworkStore.setState({ isConnected: false });
    expect(useUserStore.getState().userPersona).toBeNull();
    await init();
    await advanceUntil(() => lastRun() !== null, 30_000);
  });

  it('comes round again after 24h jittered by +/-20%, no sooner and no later', async () => {
    const factor = jitterFactor(NAME);
    expect(factor).not.toBe(1); // the seed must actually move it, or this test cannot tell jitter from none
    expect(factor).toBeGreaterThanOrEqual(0.8);
    expect(factor).toBeLessThan(1.2);
    const interval = jitteredInterval(NAME, DAY);
    await init();
    await advanceUntil(() => lastRun() !== null, 30_000);
    const first = lastRun()!;

    await jest.advanceTimersByTimeAsync(first + interval - 10_000 - Date.now());
    expect(lastRun()).toBe(first); // a tick just before it is due finds it not due

    await advanceUntil(() => lastRun() !== first, 30_000);
    expect(lastRun()! - first).toBeGreaterThanOrEqual(interval);
    expect(lastRun()! - first).toBeLessThanOrEqual(interval + 15_000);
  });

  it('is never started by a foreground event, which only starts tasks that declare the trigger', async () => {
    await init();
    await advanceUntil(() => lastRun() !== null, 30_000);
    const first = lastRun()!;
    await jest.advanceTimersByTimeAsync(2 * MIN); // past the warm foreground floor

    setAppState('background');
    setAppState('active');
    await advanceUntil(() => controlRuns > 0, 5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(controlRuns).toBe(1); // the foreground fired for a task that asks for it
    expect(lastRun()).toBe(first); // and data-cleanup, with no triggers, did not run
  });
});

describe('the sweep', () => {
  beforeEach(() => useFakeClock(NOW));

  /** Runs `work` with the clock `agoMs` in the past, then puts it back at NOW. */
  async function at(agoMs: number, work: () => Promise<unknown>): Promise<void> {
    jest.setSystemTime(NOW - agoMs);
    await work();
    jest.setSystemTime(NOW);
  }

  const news = (id: string) => ({ _id: id, title: 't', title_en_internal_only: 'Headline', article_url: `https://example.com/${id}` }) as unknown as NewsArticle;
  const checked = { checkedBy: [{ organisation: 'BOOM' }] };
  const unchecked = { checkedBy: [] };
  const fact = (articleId: string, payload: unknown) =>
    upsertFactCheck({ articleId, factCheckId: `fc-${articleId}`, status: 'complete', verdict: 'v', payload, claimKey: articleId, claim: articleId });

  const run = () => AppScheduler.trigger(NAME);
  const jobIds = async () => (await database.get('scheduler_jobs').query().fetch()).map((r: any) => [r.taskName, r.status] as const);

  async function topicId(): Promise<string> {
    const f = await addFact('I follow Berlin');
    const [t] = await createTopics([{ factId: f.id, text: 'berlin', weight: 1, provenance: 'llm' }]);
    return t.id;
  }

  it('deletes everything past its TTL, keeps everything just inside it, and leaves the rest of the run alone', async () => {
    const topic = await topicId();
    // scheduler jobs: the 7-day prune, and the dead-retry prune
    const def = registered();
    const finishedJob = async (agoMs: number) => {
      let id = '';
      await at(agoMs, async () => {
        id = (await createJob(def as never)).id;
        await markCompleted(id, NOW - agoMs);
      });
      return id;
    };
    const oldJob = await finishedJob(8 * DAY);
    const recentJob = await finishedJob(6 * DAY);
    let deadRetry = '';
    await at(10 * DAY, async () => {
      deadRetry = (await createJob(def as never)).id;
      await markFailed(deadRetry, new Error('boom'), false, NOW - 10 * DAY);
    });
    // suggestions (48h) with a fact link each
    await at(48 * HOUR + MIN, () => landSuggestions(['sug-old'], {}, topic));
    await at(48 * HOUR - MIN, () => landSuggestions(['sug-new'], {}, topic));
    await refreshSuggestionsInStoreUnsafe();
    expect(useForYouStore.getState().suggestions.map((s) => s._id).sort()).toEqual(['sug-new', 'sug-old']);
    // story impressions (30d)
    await at(30 * DAY + MIN, () => recordOpen({ articleId: 'imp-old', surface: 'feed' }));
    await at(30 * DAY - MIN, () => recordOpen({ articleId: 'imp-new', surface: 'feed' }));
    // notifications (90d)
    await at(90 * DAY + MIN, () => notify({ type: 'sync', title: 'old', body: 'b', source: 'old' }));
    await at(90 * DAY - MIN, () => notify({ type: 'sync', title: 'new', body: 'b', source: 'new' }));
    // fact checks: 7d when unattributed, 90d for everything
    await at(7 * DAY + MIN, () => fact('fc-unattr-old', unchecked));
    await at(7 * DAY - MIN, () => fact('fc-unattr-new', unchecked));
    await at(60 * DAY, () => fact('fc-attr-mid', checked));
    await at(90 * DAY + MIN, () => fact('fc-attr-ancient', checked));

    expect(await run()).toBe('ran');

    expect((await jobIds()).filter(([task]) => task === NAME).map(([, status]) => status)).toEqual(
      expect.arrayContaining(['completed']),
    );
    const jobs = (await database.get('scheduler_jobs').query().fetch()).map((r: any) => r.id as string);
    expect(jobs).toContain(recentJob);
    expect(jobs).not.toContain(oldJob);
    expect(jobs).not.toContain(deadRetry);

    expect((await loadSuggestions()).map((s) => s._id)).toEqual(['sug-new']);
    const links = (await database.get('article_suggestion_facts').query().fetch()).map((l: any) => l._raw.article_suggestion_id as string);
    expect(links).toEqual(['sug-new']);
    // the store was refreshed from the table because something was deleted
    expect(useForYouStore.getState().suggestions.map((s) => s._id)).toEqual(['sug-new']);

    expect((await getImpressions()).map((r: any) => r.articleId)).toEqual(['imp-new']);
    expect((await getNotifications()).map((n: any) => n.title)).toEqual(['new']);
    expect((await listFactChecks()).map((f) => f.articleId).sort()).toEqual(['fc-attr-mid', 'fc-unattr-new']);
    expect(lastRun()).not.toBeNull();
  });

  it('keeps a table whole when nothing in it is old, and does not refresh the suggestions store', async () => {
    const stale = await landSuggestion('stale-in-store');
    await refreshSuggestionsInStoreUnsafe();
    // the row leaves the table behind the store's back: a refresh would drop it from the store
    await deleteSuggestionsByServerIds([stale._id]);
    await landSuggestion('fresh');
    await recordOpen({ articleId: 'imp', surface: 'feed' });
    await notify({ type: 'sync', title: 't', body: 'b', source: 's' });
    await fact('fc', unchecked);

    await run();

    expect((await loadSuggestions()).map((s) => s._id)).toEqual(['fresh']);
    expect(useForYouStore.getState().suggestions.map((s) => s._id)).toEqual(['stale-in-store']);
    expect(await getImpressions()).toHaveLength(1);
    expect(await getNotifications()).toHaveLength(1);
    expect(await listFactChecks()).toHaveLength(1);
    expect(logged()).toEqual([]);
  });

  it('logs how much each step removed, and nothing for a step that removed nothing', async () => {
    await at(49 * HOUR, () => landSuggestions(['old-a', 'old-b']));
    await at(31 * DAY, () => recordOpen({ articleId: 'imp-old', surface: 'feed' }));
    await at(100 * DAY, () => fact('fc-ancient', checked));
    await at(100 * DAY, () => fact('fc-ancient-2', unchecked));
    await at(100 * DAY, () => keepArticleForFactCheck({ articleId: 'orphan-1', title: 'x' }));

    await run();

    expect(logged()).toEqual([
      `[${NAME}] pruned 2 suggestions older than 48h`,
      `[${NAME}] pruned 1 story impressions older than 30d`,
      `[${NAME}] pruned 2 fact checks (unattributed >7d, any >90d)`,
      `[${NAME}] released 1 unreferenced retained article snapshots`,
    ]);
  });

  it('sweeps the retention of a fact check it expires in the same run, because the sweep comes after the prune', async () => {
    await at(8 * DAY, async () => {
      await keepArticleForFactCheck({ articleId: 'expiring', title: 'Checked' });
      await fact('expiring', unchecked);
    });
    expect(await originsById()).toEqual({ expiring: 'fact_check' });

    await run();

    expect(await listFactChecks()).toEqual([]);
    expect(await originsById()).toEqual({});
  });

  it('sweeps retention rows no reason holds, and keeps every row a reason or the user still holds', async () => {
    const topic = await topicId();
    const held = 'held-by-check';
    await keepArticleForFactCheck({ articleId: held, title: 'Checked' });
    await fact(held, checked);
    await keepArticleForFactCheck({ articleId: 'orphan', title: 'Orphan' });
    // a followed story's member, and a user save
    const [seed] = await landSuggestions(['story-seed'], {}, topic);
    await trackStoryWithProposal(
      { origin: 'suggestion', surface: 'for_you', articleId: seed.articleId, title: 'Seed', pubDate: new Date(NOW).toISOString(), publicationName: 'P' },
      { label: 'Story', searchText: 'berlin story' },
    );
    await saveStandaloneArticle(news('saved'));

    await run();

    expect(Object.keys(await originsById()).sort()).toEqual([held, 'saved', 'story-seed'].sort());
  });

  it('stops at the first step that fails: the job retries, lastRun is not stamped and later steps wait', async () => {
    const def = registered();
    let oldJob = '';
    await at(8 * DAY, async () => {
      oldJob = (await createJob(def as never)).id;
      await markCompleted(oldJob, NOW - 8 * DAY);
    });
    await at(31 * DAY, () => recordOpen({ articleId: 'imp-old', surface: 'feed' }));
    failTableQuery('article_suggestions');

    await expect(run()).resolves.toBe('ran');

    const rows = (await database.get('scheduler_jobs').query().fetch()) as unknown as { id: string; taskName: string; status: string; errorMessage: string | null }[];
    // the job-prune step ran first and finished; the suggestion step threw and ended the run
    expect(rows.map((r) => r.id)).not.toContain(oldJob);
    expect(rows.find((r) => r.taskName === NAME)).toMatchObject({ status: 'retrying', errorMessage: 'article_suggestions query failed (injected)' });
    expect(await getImpressions()).toHaveLength(1);
    expect(lastRun()).toBeNull();
  });
});
