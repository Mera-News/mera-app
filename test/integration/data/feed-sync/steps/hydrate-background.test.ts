// stepHydratePersistEnqueue in background mode (the OS task): no foreground enqueue and no tail
// flush, the allowance ledger hooks (reserve before every metered attempt, settle to the granted
// count) and what meteredDelivered counts. Real services, in-memory DB, real Apollo on MSW, and
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

/** Reserve/settle hooks that write into the same timeline the server handlers write into. */
function ledger(timeline: string[]) {
  const reserveMetered = jest.fn(async (requested: number) => {
    timeline.push(`reserve:${requested}`);
  });
  const settleMetered = jest.fn(async (requested: number, granted: number) => {
    timeline.push(`settle:${requested}/${granted}`);
  });
  return { reserveMetered, settleMetered };
}

async function prepare(topicIds: string[], serve: HydrateServe = {}) {
  await seedInterest('I follow racing', ['formula 1']);
  const timeline: string[] = [];
  const served = serveHydrate({ timeline, ...serve });
  server.use(servePersona({ topics: { 'formula 1': topicIds } }), ...served.handlers);
  const t = makeCtx();
  const { diff } = await fetchAndDiff(t);
  return { t, diff, timeline, stats: served.stats, ...ledger(timeline) };
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

describe('the allowance ledger: reserve before every metered attempt, settle to the grant', () => {
  it('reserves BEFORE the metered request goes out and settles after the answer', async () => {
    const { t, diff, timeline, reserveMetered, settleMetered } = await prepare(ids(10));

    await hydrate(diff, t, { reserveMetered, settleMetered });

    expect(timeline).toEqual(['reserve:10', 'GetArticlesForTopicsByIds:10', 'settle:10/10']);
  });

  it('reserves once per chunk, each reservation ahead of its own request', async () => {
    const { t, diff, timeline, reserveMetered, settleMetered } = await prepare(ids(HYDRATE_CHUNK_SIZE * 3), {
      holdMs: 20,
    });

    await hydrate(diff, t, { reserveMetered, settleMetered });

    expect(reserveMetered).toHaveBeenCalledTimes(3);
    expect(settleMetered).toHaveBeenCalledTimes(3);
    let reserves = 0;
    let requests = 0;
    for (const entry of timeline) {
      if (entry.startsWith('reserve')) reserves += 1;
      if (entry.startsWith('GetArticles')) {
        requests += 1;
        expect(reserves).toBeGreaterThanOrEqual(requests);
      }
    }
  });

  it('reserves again for a retry: a retry is a second metered request', async () => {
    const { t, diff, timeline, reserveMetered, settleMetered } = await prepare(ids(10), {
      respond: ({ n }) => (n === 1 ? 'resolver-error' : undefined),
    });

    await hydrate(diff, t, { reserveMetered, settleMetered });

    expect(timeline).toEqual([
      'reserve:10',
      'GetArticlesForTopicsByIds:10',
      'reserve:10',
      'GetArticlesForTopicsByIds:10',
      'settle:10/10',
    ]);
  });

  it('settles to every requested id when the cap was not hit, even if a document was not delivered', async () => {
    const { t, diff, timeline, reserveMetered, settleMetered } = await prepare(ids(10), {
      // the server charged all ten but one document is gone
      respond: ({ ids: asked }) => ({ articles: asked.slice(1).map((id) => art(id)) }),
    });

    await hydrate(diff, t, { reserveMetered, settleMetered });

    expect(timeline.at(-1)).toBe('settle:10/10');
  });

  it('settles down to what arrived when the response reports the daily cap', async () => {
    const { t, diff, timeline, reserveMetered, settleMetered } = await prepare(ids(10), {
      respond: ({ ids: asked }) => ({
        articles: asked.slice(0, 4).map((id) => art(id)),
        dailyLimitReached: true,
        resetAt: RESET,
      }),
    });

    const { result } = await hydrate(diff, t, { reserveMetered, settleMetered });

    expect(timeline.at(-1)).toBe('settle:10/4');
    expect(result).toMatchObject({ dailyLimitReached: true, resetAt: RESET, meteredDelivered: 4 });
  });

  it('settles to zero when the cap delivered nothing, then throws the terminal daily-limit error', async () => {
    const { t, diff, timeline, reserveMetered, settleMetered } = await prepare(ids(10), {
      respond: () => ({ articles: [], dailyLimitReached: true, resetAt: RESET }),
    });

    await expect(hydrate(diff, t, { reserveMetered, settleMetered })).rejects.toMatchObject({ code: 'daily-limit' });

    expect(timeline.at(-1)).toBe('settle:10/0');
  });

  it('keeps the reservation when the request never answers: nothing is settled', async () => {
    const { t, diff, reserveMetered, settleMetered, stats } = await prepare(ids(10), {
      respond: () => 'resolver-error',
    });

    await expect(hydrate(diff, t, { reserveMetered, settleMetered })).rejects.toBeDefined();

    expect(stats.requests).toHaveLength(2);
    expect(reserveMetered).toHaveBeenCalledTimes(2);
    expect(settleMetered).not.toHaveBeenCalled();
  });

  it('sends no request when the reservation cannot be written', async () => {
    const { t, diff, stats, settleMetered } = await prepare(ids(10));
    const reserveMetered = jest.fn(async () => {
      throw new Error('ledger write failed');
    });

    await expect(hydrate(diff, t, { reserveMetered, settleMetered })).rejects.toThrow('ledger write failed');

    expect(stats.requests).toEqual([]);
    expect(settleMetered).not.toHaveBeenCalled();
  });
});

describe('followed-story chunks are quota-free', () => {
  it('reserves and settles nothing for them, and does not count them in meteredDelivered', async () => {
    await seedTracked('titan inquiry');
    await seedInterest('I follow racing', ['formula 1']);
    const timeline: string[] = [];
    const served = serveHydrate({ timeline });
    const story = ids(HYDRATE_CHUNK_SIZE + 5, 's');
    const metered = ids(7, 'm');
    server.use(servePersona({ topics: { 'titan inquiry': story, 'formula 1': metered } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);
    const { reserveMetered, settleMetered } = ledger(timeline);

    const { result } = await hydrate(diff, t, { reserveMetered, settleMetered });

    expect(reserveMetered).toHaveBeenCalledTimes(1);
    expect(reserveMetered).toHaveBeenCalledWith(7);
    expect(settleMetered).toHaveBeenCalledWith(7, 7);
    expect(result.meteredDelivered).toBe(7);
    expect(result.insertedCount).toBe(story.length + 7);
    expect(timeline.filter((e) => e.startsWith('GetArticlesForStories')).length).toBe(2);
  });
});
