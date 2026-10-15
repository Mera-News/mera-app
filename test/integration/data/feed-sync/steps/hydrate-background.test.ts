// stepHydratePersistEnqueue in background mode (the OS task): no foreground enqueue and no tail
// flush; the two hydrators (followed stories, everything else); and a server that still caps
// downloads. Real services, in-memory DB, real Apollo on MSW, and
// the gateway mock as the witness that nothing reached scoring.
// Replaces the "background mode" blocks of lib/scheduler/feed-sync/__tests__/feed-sync-steps.test.ts.
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

import { HYDRATE_CHUNK_SIZE } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { getPipelineStatus } from '@/lib/services/scoring-pipeline';
import { advanceUntilDone, attestationRequests, gatewayCalls, server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  fetchAndDiff,
  foreground,
  hydrate,
  ids,
  makeCtx,
  resetFeedSyncMemory,
  resetScoringWorld,
  scoredIds,
  seedInterest,
  seedTracked,
  servePersona,
  serveHydrate,
  suggestionRows,
  tick,
  tickUntilScored,
  type HydrateServe,
} from './support';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

async function prepare(topicIds: string[], serve: HydrateServe = {}) {
  await seedInterest('I follow racing', ['formula 1']);
  const timeline: string[] = [];
  const served = serveHydrate({ timeline, ...serve });
  server.use(servePersona({ topics: { 'formula 1': topicIds } }), ...served.handlers);
  const t = makeCtx();
  const { diff } = await fetchAndDiff(t);
  return { t, diff, timeline, stats: served.stats };
}

const RESET = '2026-06-26T00:00:00.000Z';

describe('a background run hands nothing to the foreground scoring pipeline', () => {
  // The same suppressed run twice, on the scoring world of hydrate-enqueue (signed in, fake clock,
  // pipeline able to reach the gateway). The only difference is the `background` flag.
  beforeEach(resetScoringWorld);

  async function suppressedRun(background: boolean) {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': ids(7) } }), ...serveHydrate().handlers);
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));
    const { result } = await foreground(t, diff, { suppressEnqueue: true, background });
    // The background run scores nothing, so tick a fixed 20 times; the control waits for its 7.
    if (background) for (let i = 0; i < 20; i++) await tick();
    else await tickUntilScored(7);
    await tick();
    return result;
  }

  it('(control) a suppressed foreground run flushes its rows into the idle pipeline, which reaches the gateway', async () => {
    await suppressedRun(false);

    expect(scoredIds().sort()).toEqual(ids(7));
  });

  it('persists and returns the scorable ids but enqueues nothing and never flushes a tail', async () => {
    const result = await suppressedRun(true);

    expect([...result.eligibleIds].sort()).toEqual(ids(7));
    expect(result.enqueuedCount).toBe(0);
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
    expect(await getPipelineStatus()).toBe('idle');
    expect(await suggestionRows()).toHaveLength(7);
  });
});

describe('a server that still caps downloads', () => {
  it('a granted prefix is kept: no throw, no cap fields in the result', async () => {
    const { t, diff } = await prepare(ids(10), {
      respond: ({ ids: asked }) => ({
        articles: asked.slice(0, 4).map((id) => art(id)),
        dailyLimitReached: true,
        resetAt: RESET,
      }),
    });

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(4);
    expect(Object.keys(result).sort()).toEqual(['eligibleIds', 'enqueuedCount', 'insertedCount']);
  });

  it('nothing delivered is an ordinary empty hydrate, never a terminal error', async () => {
    const { t, diff, stats } = await prepare(ids(HYDRATE_CHUNK_SIZE * 2), {
      respond: () => ({ articles: [], dailyLimitReached: true, resetAt: RESET }),
    });

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(0);
    // Every chunk is still asked for: no pool stop on an empty chunk.
    expect(stats.requests).toHaveLength(2);
  });
});

describe('followed-story chunks go through the quota-exempt query', () => {
  it('story-only ids are hydrated by GetArticlesForStories, the rest by GetArticlesForTopicsByIds', async () => {
    await seedTracked('titan inquiry');
    await seedInterest('I follow racing', ['formula 1']);
    const timeline: string[] = [];
    const served = serveHydrate({ timeline });
    const story = ids(HYDRATE_CHUNK_SIZE + 5, 's');
    const metered = ids(7, 'm');
    server.use(servePersona({ topics: { 'titan inquiry': story, 'formula 1': metered } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(story.length + 7);
    expect(timeline.filter((e) => e.startsWith('GetArticlesForStories')).length).toBe(2);
    expect(timeline.filter((e) => e.startsWith('GetArticlesForTopicsByIds'))).toEqual(['GetArticlesForTopicsByIds:7']);
  });
});
