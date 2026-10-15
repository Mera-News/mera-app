// stepHydratePersistEnqueue, foreground-agnostic half: chunking, the two hydrators, persistence,
// progress, pause and abort, the daily limit, the resolver-error retry and the already-read
// exclusion. Real services, in-memory DB, real Apollo on MSW. Every run here suppresses the
// enqueue (see `hydrate` in ./support); the enqueue itself is hydrate-enqueue.test.ts.
// Replaces the stepHydratePersistEnqueue blocks of
// lib/scheduler/feed-sync/__tests__/feed-sync-steps.test.ts.
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

import * as suppressionSweep from '@/lib/services/suppression-sweep';
import * as suggestionService from '@/lib/database/services/article-suggestion-reads';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { buildReadStoryIndex } from '@/lib/feed-grouping/read-story-filter';
import * as readStoryFilter from '@/lib/feed-grouping/read-story-filter';
import {
  HYDRATE_CHUNK_SIZE,
  HYDRATE_CONCURRENCY,
  splitAlreadyReadArticles,
} from '@/lib/scheduler/feed-sync/feed-sync-steps';
import logger from '@/lib/logger';
import { server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  diffOf,
  fetchAndDiff,
  flush,
  hydrate,
  ids,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  rowsById,
  seedInterest,
  seedTracked,
  servePersona,
  serveHydrate,
  spyOnExport,
  stageRowsById,
  suggestionRows,
  type HydrateServe,
} from './support';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

/** An interest topic whose matches are `topicIds`, the fetch and diff done, hydrate handlers installed. */
async function prepare(topicIds: string[], serve: HydrateServe = {}, headlineIds: string[] = []) {
  const { fact, topics } = await seedInterest('I follow racing', ['formula 1']);
  const served = serveHydrate(serve);
  server.use(
    servePersona({
      topics: { 'formula 1': topicIds },
      headlines: headlineIds.length ? [{ scope: 'GLOBAL', ids: headlineIds }] : [],
    }),
    ...served.handlers,
  );
  const t = makeCtx();
  const { fetched, diff } = await fetchAndDiff(t);
  return { t, fetched, diff, stats: served.stats, factId: fact.id, topicId: topics[0].id };
}

const DRY = (resetAt: string) => ({ articles: [], dailyLimitReached: true, resetAt });

describe('chunking and concurrency', () => {
  it('hydrates in chunks of HYDRATE_CHUNK_SIZE, one request per chunk, in server order', async () => {
    const all = ids(60);
    const { t, diff, stats } = await prepare(all);

    await hydrate(diff, t);

    const sizes = stats.requests.map((r) => r.ids.length).sort((a, b) => a - b);
    expect(sizes).toEqual([60 - 2 * HYDRATE_CHUNK_SIZE, HYDRATE_CHUNK_SIZE, HYDRATE_CHUNK_SIZE]);
    const byFirstId = [...stats.requests].sort((a, b) => a.ids[0].localeCompare(b.ids[0]));
    expect(byFirstId.flatMap((r) => r.ids)).toEqual(all);
    expect(new Set(stats.requests.map((r) => r.op))).toEqual(new Set(['GetArticlesForTopicsByIds']));
  });

  it('keeps exactly HYDRATE_CONCURRENCY chunk requests in flight', async () => {
    const { t, diff, stats } = await prepare(ids(HYDRATE_CHUNK_SIZE * 8), { holdMs: 40 });

    await hydrate(diff, t);

    expect(stats.requests).toHaveLength(8);
    expect(stats.maxInFlight).toBe(HYDRATE_CONCURRENCY);
  });

  it('hydrates followed-story ids through the quota-free query and the rest through the metered one, story chunks first', async () => {
    await seedTracked('titan inquiry');
    const story = ids(HYDRATE_CHUNK_SIZE + 5, 's');
    const metered = ids(HYDRATE_CHUNK_SIZE + 5, 'm');
    await seedInterest('I follow racing', ['formula 1']);
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'titan inquiry': story, 'formula 1': metered } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);
    expect(diff.storyIds).toEqual(story);

    await hydrate(diff, t);

    const ofOp = (op: string) => served.stats.requests.filter((r) => r.op === op);
    expect(ofOp('GetArticlesForStories').flatMap((r) => r.ids).sort()).toEqual([...story].sort());
    expect(ofOp('GetArticlesForTopicsByIds').flatMap((r) => r.ids).sort()).toEqual([...metered].sort());
    // each side chunks on its own
    expect(ofOp('GetArticlesForStories').map((r) => r.ids.length).sort((a, b) => a - b)).toEqual([5, HYDRATE_CHUNK_SIZE]);
    expect(ofOp('GetArticlesForTopicsByIds').map((r) => r.ids.length).sort((a, b) => a - b)).toEqual([5, HYDRATE_CHUNK_SIZE]);
  });

  it('carries the server order into the hydrate requests: every topic-matched id is requested before any headline id', async () => {
    const topicIds = ids(HYDRATE_CHUNK_SIZE + 5, 't');
    const headlineIds = ids(20, 'h');
    const { t, diff, stats } = await prepare(topicIds, {}, headlineIds);
    expect(diff.missingIds).toEqual([...topicIds, ...headlineIds]);

    await hydrate(diff, t);

    // chunk 0 is all topics; the headlines start only after the last topic id
    const chunks = stats.requests.map((r) => r.ids);
    expect(chunks).toContainEqual(topicIds.slice(0, HYDRATE_CHUNK_SIZE));
    expect(chunks).toContainEqual([...topicIds.slice(HYDRATE_CHUNK_SIZE), ...headlineIds]);
  });

  it('a metered query that delivers nothing still lets every followed-story article land', async () => {
    await seedTracked('titan inquiry');
    await seedInterest('I follow racing', ['formula 1']);
    const story = ids(HYDRATE_CHUNK_SIZE + 5, 's');
    const metered = ids(HYDRATE_CHUNK_SIZE * 5, 'm');
    const served = serveHydrate({
      respond: ({ op }) => (op === 'GetArticlesForTopicsByIds' ? DRY('2026-06-26T00:00:00.000Z') : undefined),
    });
    server.use(servePersona({ topics: { 'titan inquiry': story, 'formula 1': metered } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(story.length);
    expect((await suggestionRows()).map((r) => r._id).sort()).toEqual([...story].sort());
  });

  it('falls back to the metered query for a diff that never went through the partition', async () => {
    const served = serveHydrate();
    server.use(...served.handlers);

    await hydrate(diffOf(ids(3)), makeCtx());

    expect(served.stats.requests.map((r) => r.op)).toEqual(['GetArticlesForTopicsByIds']);
  });

  it('with nothing to hydrate, sends nothing and returns zeros', async () => {
    const served = serveHydrate();
    server.use(...served.handlers);
    const sent = recordOps();

    const { result } = await hydrate(diffOf([]), makeCtx());

    expect(await sent.all()).toEqual([]);
    expect(result).toEqual({
      insertedCount: 0,
      enqueuedCount: 0,
      eligibleIds: [],
    });
  });

  it('an already-aborted signal throws a cancellation before any request', async () => {
    const served = serveHydrate();
    server.use(...served.handlers);
    const t = makeCtx();
    t.abort();

    await expect(hydrate(diffOf(ids(3)), t)).rejects.toMatchObject({ name: 'AbortError', message: 'aborted' });

    expect(served.stats.requests).toEqual([]);
  });

  it('an abort after the first pool started launches no further chunk and returns what landed', async () => {
    const { t, diff, stats } = await prepare(ids(HYDRATE_CHUNK_SIZE * 5));

    const { result } = await hydrate(diff, t, {
      refreshStore: jest.fn(async () => {
        t.abort();
      }),
    });

    expect(stats.requests).toHaveLength(HYDRATE_CONCURRENCY);
    expect(result.insertedCount).toBeGreaterThan(0);
  });
});

describe('pause and progress hooks', () => {
  it('blocks between chunks while the machine is paused, and carries on when resumed', async () => {
    const { t, diff, stats } = await prepare(ids(HYDRATE_CHUNK_SIZE * 5));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    // the pool's first look at the gate is free; every later one waits for the resume
    const run = hydrate(diff, t, {
      awaitResumeIfPaused: jest.fn(() => (++calls <= HYDRATE_CONCURRENCY ? Promise.resolve() : gate)),
    });
    await flush(400);
    expect(stats.requests).toHaveLength(HYDRATE_CONCURRENCY);

    release();
    await run;

    expect(stats.requests).toHaveLength(5);
  });

  it('reports cumulative progress: the completed total after each chunk, ending at the full count', async () => {
    const all = ids(HYDRATE_CHUNK_SIZE * 2 + 10);
    // chunk responses arrive in order, so completed totals are 25, 50, 60
    const { t, diff } = await prepare(all, { holdMs: (n) => n * 60 });

    const { onProgress } = await hydrate(diff, t);

    const seen = onProgress.mock.calls.map(([n]) => n as number);
    expect(seen.at(-1)).toBe(all.length);
    expect(Math.max(...seen)).toBe(all.length);
    const afterChunk = [HYDRATE_CHUNK_SIZE, HYDRATE_CHUNK_SIZE * 2, all.length];
    expect(seen.filter((n) => afterChunk.includes(n)).filter((n, i, a) => a.indexOf(n) === i)).toEqual(afterChunk);
  });

  it('refreshes the store once per persisted chunk so rows render progressively', async () => {
    const { t, diff } = await prepare(ids(HYDRATE_CHUNK_SIZE * 2 + 1));

    const { refreshStore } = await hydrate(diff, t);

    expect(refreshStore).toHaveBeenCalledTimes(3);
  });
});

describe('what lands in article_suggestions', () => {
  it('stores each article with its matched topic refs, headline scope and the server stable cluster id', async () => {
    const { t, diff, topicId } = await prepare(['t1'], {}, ['h1']);

    await hydrate(diff, t);

    const rows = await rowsById();
    const stable = await stageRowsById(['t1', 'h1']);
    expect(rows.size).toBe(2);
    const topicRow = rows.get('t1')!;
    expect(topicRow.status).toBe('unscored');
    expect(topicRow.matchedTopics).toEqual([{ topicId, text: 'formula 1' }]);
    expect(topicRow.headlineScope).toBeNull();
    // the server's largest-cluster id (matchMeta) wins over the article's own membership
    expect(stable.get('t1')!.stableClusterId).toBe('stable-t1');
    const headline = rows.get('h1')!;
    expect(headline.matchedTopics).toEqual([{ topicId: null, text: 'top headline · global' }]);
    expect(headline.headlineScope).toBe('GLOBAL');
    expect(stable.get('h1')!.headlineCountryCode).toBeNull();
    expect(stable.get('h1')!.stableClusterId).toBe('stable-h1');
  });

  it('links a topic-matched row to the fact that owns the topic and a headline row to none', async () => {
    const { t, diff, factId } = await prepare(['t1'], {}, ['h1']);

    await hydrate(diff, t);

    const rows = await rowsById();
    expect(rows.get('t1')!.factIds).toEqual([factId]);
    expect(rows.get('h1')!.factIds).toEqual([]);
  });

  it('falls back to the article own cluster membership when the server named no stable id', async () => {
    const served = serveHydrate();
    server.use(...served.handlers);

    await hydrate(diffOf(['bare']), makeCtx());

    expect((await stageRowsById(['bare'])).get('bare')!.stableClusterId).toBe('member-bare');
  });

  it('persists an article that arrives twice (one copy per matched topic) exactly once', async () => {
    const { t, diff } = await prepare(['a', 'dup', 'b'], { twice: ['dup'] });

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(3);
    const rows = await suggestionRows();
    expect(rows.map((r) => r._id).sort()).toEqual(['a', 'b', 'dup']);
    expect(rows).toHaveLength(3);
  });

  it('does not rewrite a row already on the device', async () => {
    const { t, diff } = await prepare(['a', 'b']);
    await hydrate(diff, t);

    const again = await hydrate(diffOf(['a', 'b']), t);

    expect(again.result.insertedCount).toBe(0);
    expect(await suggestionRows()).toHaveLength(2);
  });

  it('returns the persisted scorable ids in chunk order as eligibleIds', async () => {
    const { t, diff } = await prepare(['a', 'b', 'c']);

    const { result } = await hydrate(diff, t);

    expect([...result.eligibleIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('tombstones a row missing its English text and leaves it out of eligibleIds', async () => {
    const { t, diff } = await prepare(['ok', 'blank'], {
      article: (id) => (id === 'blank' ? art(id, { title_en: undefined, description_en: undefined }) : art(id)),
    });

    const { result } = await hydrate(diff, t);

    expect(result.eligibleIds).toEqual(['ok']);
    expect((await rowsById()).get('blank')!.status).toBe('complete');
  });

  it('reports only this run\'s rows as eligibleIds: rows an earlier sync left unscored are not reported again', async () => {
    const { t, diff } = await prepare(['a', 'b']);
    await hydrate(diff, t);
    server.use(servePersona({ topics: { 'formula 1': ['a', 'b', 'c'] } }));
    const next = await fetchAndDiff(t);

    const { result } = await hydrate(next.diff, t);

    expect(result.eligibleIds).toEqual(['c']);
    expect((await rowsById()).get('a')!.status).toBe('unscored');
  });

  it('still takes a top-headline row with no English text out of scoring (tombstoned, then culled as relevance 0)', async () => {
    const { t, diff } = await prepare(['t1'], {
      article: (id) => (id === 'h1' ? art(id, { title_en: undefined, description_en: undefined }) : art(id)),
    }, ['h1']);

    const { result } = await hydrate(diff, t);

    expect(result.eligibleIds).toEqual(['t1']);
    expect(['complete', 'excluded']).toContain((await rowsById()).get('h1')!.status);
  });

  it('skips the gate when nothing eligible was persisted', async () => {
    const { t, diff } = await prepare(['blank'], { article: (id) => art(id, { title_en: undefined, description_en: undefined }) });

    await hydrate(diff, t);

    expect(t.log.mock.calls.some(([line]) => String(line).startsWith('gate:'))).toBe(false);
  });

  it('keeps a factless top-headline row scorable', async () => {
    const { t, diff } = await prepare(['t1'], {}, ['h1']);

    const { result } = await hydrate(diff, t);

    expect(result.eligibleIds.sort()).toEqual(['h1', 't1']);
  });
});

// Until the server's download cap is switched off, articlesForTopicsByIds may answer a granted
// prefix, possibly empty, with dailyLimitReached set. The app does not select that flag: a capped
// answer is just a shorter one.
describe('a server that still caps downloads', () => {
  it('a dry chunk keeps what its siblings delivered, and every chunk is still asked for', async () => {
    const reset = '2026-06-26T00:00:00.000Z';
    const { t, diff, stats } = await prepare(ids(HYDRATE_CHUNK_SIZE * 5), {
      respond: ({ n }) => (n === 1 ? DRY(reset) : undefined),
    });

    const { result } = await hydrate(diff, t);

    expect(stats.requests).toHaveLength(5);
    expect(result.insertedCount).toBe(HYDRATE_CHUNK_SIZE * 4);
    expect(await suggestionRows()).toHaveLength(HYDRATE_CHUNK_SIZE * 4);
  });

  it('every chunk dry: an ordinary empty hydrate, never a terminal error', async () => {
    const { t, diff, stats } = await prepare(ids(HYDRATE_CHUNK_SIZE * 5), {
      respond: () => DRY('2026-06-27T00:00:00.000Z'),
    });

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(0);
    expect(stats.requests).toHaveLength(5);
    expect(await suggestionRows()).toEqual([]);
  });

  it('a quota-free body that carries the cap fields changes nothing', async () => {
    await seedTracked('titan inquiry');
    const served = serveHydrate({
      respond: ({ op, ids: asked }) =>
        op === 'GetArticlesForStories'
          ? { articles: asked.map((id) => art(id)), dailyLimitReached: true, resetAt: '2026-06-27T00:00:00.000Z' }
          : undefined,
    });
    server.use(servePersona({ topics: { 'titan inquiry': ['s1', 's2'] } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(2);
  });

  it('a followed-story-only run never calls the metered query', async () => {
    await seedTracked('titan inquiry');
    const served = serveHydrate({ respond: ({ op }) => (op === 'GetArticlesForTopicsByIds' ? DRY('2026-06-27T00:00:00.000Z') : undefined) });
    server.use(servePersona({ topics: { 'titan inquiry': ['s1', 's2'] } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);

    const { result } = await hydrate(diff, t);

    expect(served.stats.requests.map((r) => r.op)).toEqual(['GetArticlesForStories']);
    expect(result.insertedCount).toBe(2);
  });
});

describe('a GraphQL error inside a 200 (RESOLVER_ERROR_RETRIES = 1)', () => {
  it('is retried once and the retry succeeds: two requests, rows land', async () => {
    const { t, diff, stats } = await prepare(['a', 'b'], {
      respond: ({ n }) => (n === 1 ? 'resolver-error' : undefined),
    });

    const { result } = await hydrate(diff, t);

    expect(stats.requests).toHaveLength(2);
    expect(result.insertedCount).toBe(2);
  });

  it('cancels instead of retrying when the run is aborted while the request fails', async () => {
    const { t, diff, stats } = await prepare(['a', 'b'], {
      respond: () => {
        t.abort();
        return 'resolver-error';
      },
    });

    await expect(hydrate(diff, t)).rejects.toMatchObject({ name: 'AbortError', message: 'aborted' });

    expect(stats.requests).toHaveLength(1);
  });

  it('surfaces after the one retry fails: two requests, then the error', async () => {
    const { t, diff, stats } = await prepare(['a', 'b'], { respond: () => 'resolver-error' });

    await expect(hydrate(diff, t)).rejects.toBeDefined();

    expect(stats.requests).toHaveLength(2);
    expect(await suggestionRows()).toEqual([]);
  });
});

describe('already-read exclusion', () => {
  const READ_TITLE = 'Harbour bridge repairs begin in Fixtureville';

  it('never stores an article the reader already opened, by id', async () => {
    await recordOpen({ articleId: 'opened', titleNorm: null, surface: 'feed' });
    const { t, diff } = await prepare(['opened', 'fresh']);

    const { result } = await hydrate(diff, t);

    expect([...(await rowsById()).keys()]).toEqual(['fresh']);
    expect(result.insertedCount).toBe(1);
    expect(t.log).toHaveBeenCalledWith('skipped 1 already-read articles');
  });

  it('never stores a re-serve of a read story under a new id when the title matches', async () => {
    await recordOpen({ articleId: 'old-id', titleNorm: READ_TITLE.toLowerCase(), surface: 'feed' });
    const { t, diff } = await prepare(['new-id', 'other'], {
      article: (id) => (id === 'new-id' ? art(id, { title_en: READ_TITLE, title: READ_TITLE }) : art(id)),
    });

    await hydrate(diff, t);

    expect([...(await rowsById()).keys()]).toEqual(['other']);
  });

  it('writes an already-synced unscored row of a story read since as already_read and withholds it from scoring', async () => {
    const { t, diff } = await prepare(['early'], {
      article: (id) => (id === 'early' ? art(id, { title_en: READ_TITLE, title: READ_TITLE }) : art(id)),
    });
    await hydrate(diff, t);
    expect((await rowsById()).get('early')!.status).toBe('unscored');
    await recordOpen({ articleId: 'unrelated-open', titleNorm: READ_TITLE.toLowerCase(), surface: 'feed' });

    server.use(servePersona({ topics: { 'formula 1': ['early', 'later'] } }));
    const second = await fetchAndDiff(t);
    expect(second.diff.missingIds).toEqual(['later']);

    const { result } = await hydrate(second.diff, t);

    expect((await rowsById()).get('early')!.status).toBe('already_read');
    expect(result.eligibleIds).toEqual(['later']);
  });

  it('a chunk that was entirely already read persists nothing and throws nothing', async () => {
    await recordOpen({ articleId: 'r1', titleNorm: null, surface: 'feed' });
    const { t, diff } = await prepare(['r1'], {
      respond: () => ({ articles: [art('r1')], dailyLimitReached: true, resetAt: '2026-06-27T00:00:00.000Z' }),
    });

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(0);
  });

  it('reports a failed already_read write and carries on, the gate marking the row on the same run', async () => {
    const { t, diff } = await prepare(['early'], {
      article: (id) => (id === 'early' ? art(id, { title_en: READ_TITLE, title: READ_TITLE }) : art(id)),
    });
    await hydrate(diff, t);
    await recordOpen({ articleId: 'unrelated-open', titleNorm: READ_TITLE.toLowerCase(), surface: 'feed' });
    spyOnExport(readStoryFilter, 'batchMarkAlreadyRead').mockRejectedValueOnce(new Error('write lost'));

    server.use(servePersona({ topics: { 'formula 1': ['early', 'later'] } }));
    const second = await fetchAndDiff(t);

    const { result } = await hydrate(second.diff, t);

    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'write lost' }),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'batchMarkAlreadyRead' }) }),
    );
    expect(result.eligibleIds).toEqual(['later']);
    expect((await rowsById()).get('early')!.status).toBe('already_read');
  });
});

describe('the gate and the headline cull inside the hydrate', () => {
  const LOW = 0.4;
  const MEDIUM = 0.6;
  const scored = (relevance: number) => ({ relevance, reason: '', reasonSkipped: true });

  it('excludes a stored LOW-band top-headline row, and leaves LOW topic rows and MEDIUM headlines alone', async () => {
    const { t, diff } = await prepare(['topic-low'], {}, ['head-low', 'head-medium']);
    await hydrate(diff, t);
    await saveScoringResult('topic-low', scored(LOW));
    await saveScoringResult('head-low', scored(LOW));
    await saveScoringResult('head-medium', scored(MEDIUM));
    server.use(servePersona({ topics: { 'formula 1': ['topic-low', 'next'] } }));
    const next = await fetchAndDiff(t);

    await hydrate(next.diff, t);

    const rows = await rowsById();
    expect(rows.get('head-low')!.status).toBe('excluded');
    expect(rows.get('topic-low')!.status).toBe('complete');
    expect(rows.get('head-medium')!.status).toBe('complete');
  });

  it('writes nothing when no headline row is cullable', async () => {
    const { t, diff } = await prepare(['t1']);

    await hydrate(diff, t);

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('culled'));
  });

  it('reports a failing cull sweep and still completes the step', async () => {
    const { t, diff } = await prepare(['t1']);
    spyOnExport(suggestionService, 'getCullableLowHeadlineIds').mockRejectedValueOnce(new Error('sweep failed'));

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(1);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'sweep failed' }),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'cullLowHeadlines' }) }),
    );
  });

  it('copies a scored sibling\'s verdict onto a re-served duplicate and refreshes the store for it at once', async () => {
    const SAME = 'Harbour bridge repairs begin in Fixtureville after months of planning delays';
    const { t, diff } = await prepare(['donor'], {
      article: (id) => art(id, { title_en: SAME, title: SAME }),
    });
    await hydrate(diff, t);
    await saveScoringResult('donor', { relevance: 0.8, reason: `Covers ${SAME}`, reasonSkipped: false });
    server.use(servePersona({ topics: { 'formula 1': ['donor', 'copy'] } }));
    const next = await fetchAndDiff(t);

    const { refreshStore } = await hydrate(next.diff, t);

    const copy = (await rowsById()).get('copy')!;
    expect(copy.status).toBe('complete');
    expect(copy.relevance).toBe(0.8);
    expect(copy.reason).toBe(`Covers ${SAME}`);
    // once for the persisted chunk, once for the rows the gate completed without inference
    expect(refreshStore).toHaveBeenCalledTimes(2);
  });

  it('reports a failing hard-filter reconcile after a propagation and keeps the propagated row', async () => {
    const SAME = 'Harbour bridge repairs begin in Fixtureville after months of planning delays';
    const { t, diff } = await prepare(['donor'], {
      article: (id) => art(id, { title_en: SAME, title: SAME }),
    });
    await hydrate(diff, t);
    await saveScoringResult('donor', { relevance: 0.8, reason: `Covers ${SAME}`, reasonSkipped: false });
    server.use(servePersona({ topics: { 'formula 1': ['donor', 'copy'] } }));
    const next = await fetchAndDiff(t);
    spyOnExport(suppressionSweep, 'purgeHardFilteredSuggestions').mockRejectedValueOnce(new Error('sweep failed'));

    await hydrate(next.diff, t);

    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'sweep failed' }),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'reconcile-hard-filters' }) }),
    );
    expect((await rowsById()).get('copy')!.status).toBe('complete');
  });
});

describe('splitAlreadyReadArticles', () => {
  it('returns the input array itself, counting nothing, when no read is recorded', () => {
    const list = [art('a'), art('b')];

    const out = splitAlreadyReadArticles(list, buildReadStoryIndex([]));

    expect(out.toPersist).toBe(list);
    expect(out.readCount).toBe(0);
  });

  it('splits by article id only', () => {
    const index = buildReadStoryIndex([
      { articleId: 'by-id', opened: true },
    ]);
    const list = [
      art('by-id'),
      art('own', { clusters: [{ clusterId: 'c', confidence: 1, stableClusterId: 'sc-own' }] }),
      art('meta', { clusters: [] }),
      art('keep'),
    ];
    const out = splitAlreadyReadArticles(list, index);

    expect(out.toPersist.map((a) => a._id)).toEqual(['own', 'meta', 'keep']);
    expect(out.readCount).toBe(1);
  });

  it('ignores a scroll-past impression: only opens count', () => {
    const index = buildReadStoryIndex([{ articleId: 'a', opened: false }]);

    const out = splitAlreadyReadArticles([art('a')], index);

    expect(out.readCount).toBe(0);
  });
});
