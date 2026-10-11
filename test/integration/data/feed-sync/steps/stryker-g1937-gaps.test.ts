// Arms of the feed-sync steps and the tracked-story reconcile that only the G19/G37 legacy suites
// reached: the already-read screen on an English title, an aborted fetch, a foreground hydrate with
// nothing to score, a suppressed hydrate beside a live run, the greedy gate that must not flush
// early, a daily cap that arrives with articles, the already-read backfill, and a followed story's
// member image. Real steps, in-memory DB, MSW at the network edge, the gateway mock for scoring.
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

import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { getSetting } from '@/lib/database/services/setting-service';
import { PERSONA_V3_MIGRATION_KEY } from '@/lib/services/persona-migration-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { getTrackedStoryById, observeActive } from '@/lib/database/services/tracked-story-service';
import { loadReadStoryIndex } from '@/lib/feed-grouping/read-story-filter';
import {
  HYDRATE_CHUNK_SIZE,
  splitAlreadyReadArticles,
  stepFetchTopicIds,
} from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { reconcileTrackedStories } from '@/lib/scheduler/feed-sync/tracked-story-reconcile';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { trackStoryWithProposal } from '@/lib/tracking/track-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { firstValueFrom } from 'rxjs';
import { advanceUntilDone, assertNoGatewayViolations, gatewayCalls, server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  fetchAndDiff,
  foreground,
  hydrate,
  ids,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  resetScoringWorld,
  rowsById,
  seedInterest,
  servePersona,
  serveHydrate,
  tickUntilScored,
  type TestCtx,
} from './support';

// Real clock by default; the describes that reach the scoring pipeline switch to the fake clock.
let fakeClock = false;
const drive = <T>(p: Promise<T>): Promise<T> => (fakeClock ? advanceUntilDone(p) : p);
beforeEach(() => {
  fakeClock = false;
  resetFeedSyncMemory();
});
afterEach(() => {
  cleanupFeedSync();
  assertNoGatewayViolations();
});

/** Seed one interest, serve `topicIds` for it, and fetch + diff. */
async function prepare(topicIds: string[], serve: Parameters<typeof serveHydrate>[0] = {}) {
  await seedInterest('I follow racing', ['formula 1']);
  const served = serveHydrate(serve);
  server.use(servePersona({ topics: { 'formula 1': topicIds } }), ...served.handlers);
  const t = makeCtx();
  const { diff } = await drive(fetchAndDiff(t));
  return { t, diff, served };
}

const noEnglish = (id: string) => art(id, { title_en: undefined, description_en: undefined });

describe('the already-read screen matches on the English title', () => {
  it('splits out an article whose English title matches an opened story though its original title shares nothing', async () => {
    await recordOpen({
      articleId: 'opened-elsewhere',
      titleNorm: 'harbour bridge repairs begin downtown after planning delays',
      surface: 'feed',
    });
    const index = await loadReadStoryIndex();
    const reread = art('other-id', {
      title_en: 'Harbour bridge repairs begin downtown after planning delays',
      title: 'zzqq xxvv wwkk',
    });
    const fresh = art('fresh-id');

    const { toPersist, readCount } = splitAlreadyReadArticles([reread, fresh], index);

    expect(readCount).toBe(1);
    expect(toPersist.map((a) => a._id)).toEqual(['fresh-id']);
  });
});

describe('stepFetchTopicIds after an abort', () => {
  it('refuses as a cancellation and sends no request', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    const sent = recordOps();
    const t = makeCtx();
    t.abort();

    await expect(stepFetchTopicIds('', t.ctx)).rejects.toMatchObject({ name: 'AbortError' });

    expect(await sent.all()).toEqual([]);
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBeNull(); // nothing downstream of the guard ran
  });
});

describe('a foreground hydrate with nothing to score', () => {
  beforeEach(async () => {
    await resetScoringWorld();
    fakeClock = true;
  });

  it('starts no scoring run and posts no job when every article is ineligible', async () => {
    const { t, diff } = await prepare(ids(4), { article: noEnglish });

    const { result } = await foreground(t, diff);

    expect(result.insertedCount).toBe(4);
    expect(result.eligibleIds).toEqual([]);
    expect(await getPipeline()).toBeNull();
    expect(await pipeline.getPipelineStatus()).toBe('idle');
    expect(gatewayCalls()).toEqual([]);
  });

  it('starts no scoring run and posts no job when every article is a story already read', async () => {
    await recordOpen({ articleId: 'a000', titleNorm: 'unrelated words only', surface: 'feed' });
    await recordOpen({ articleId: 'a001', titleNorm: 'other unrelated words', surface: 'feed' });
    const { t, diff } = await prepare(['a000', 'a001']);

    const { result } = await foreground(t, diff);

    expect(result.insertedCount).toBe(0);
    expect(await getPipeline()).toBeNull();
    expect(await pipeline.getPipelineStatus()).toBe('idle');
    expect(gatewayCalls()).toEqual([]);
  });
});

describe('a suppressed hydrate beside a live scoring run', () => {
  beforeEach(async () => {
    await resetScoringWorld();
    fakeClock = true;
  });

  it('leaves the run without new batches and posts no new job, even with more than the dispatch floor', async () => {
    const first = ids(12);
    const one = await prepare(first);
    await foreground(one.t, one.diff);
    await tickUntilScored(first.length);
    expect(await pipeline.getPipelineStatus()).toBe('running');
    const batchesBefore = (await getPipeline())!.run.batches.length;
    const jobsBefore = gatewayCalls('job').length;

    const later = ids(pipeline.MIN_DISPATCH + 1, 'z');
    server.use(servePersona({ topics: { 'formula 1': later } }));
    const { diff } = await drive(fetchAndDiff(one.t));
    const { result } = await foreground(one.t, diff, { suppressEnqueue: true });

    expect(result.eligibleIds.sort()).toEqual(later);
    expect(result.enqueuedCount).toBe(0);
    expect((await getPipeline())!.run.batches).toHaveLength(batchesBefore);
    expect(gatewayCalls('job')).toHaveLength(jobsBefore);
  });
});

describe('the greedy gate across chunks', () => {
  beforeEach(async () => {
    await resetScoringWorld();
    fakeClock = true;
  });

  it('holds each short chunk back and flushes only the trailing remainder after hydration', async () => {
    // Two chunks of 25 with 3 eligible each: neither reaches the floor of 5, together they exceed it.
    const all = ids(HYDRATE_CHUNK_SIZE * 2);
    const eligible = new Set(all.filter((_, i) => i % HYDRATE_CHUNK_SIZE < 3));
    let t!: TestCtx;
    const gated = () => t.log.mock.calls.some(([line]) => String(line).startsWith('gate:'));
    const prepared = await prepare(all, {
      article: (id) => (eligible.has(id) ? art(id) : noEnglish(id)),
      // chunk 2 is not served until chunk 1 has been through the gate, so the gate sees them one at a time
      gate: async ({ n }) => {
        if (n === 1) return;
        while (!gated()) await new Promise((r) => setImmediate(r));
      },
    });
    t = prepared.t;

    await foreground(t, prepared.diff);

    const batches = (await getPipeline())!.run.batches;
    expect(batches.map((b) => b.candidateIds.length)).toEqual([pipeline.MIN_DISPATCH, 1]);
  });
});

describe('an empty, uncapped chunk', () => {
  it('does not stop the pool: a chunk launched after it is still requested and saved', async () => {
    // 4 chunks, 3 workers: the 4th is launched only by the worker whose chunk came back empty
    const all = ids(HYDRATE_CHUNK_SIZE * 4);
    const { t, diff, served } = await prepare(all, {
      holdMs: (n) => (n === 1 ? 0 : 200),
      respond: ({ n }) => (n === 1 ? { articles: [] } : undefined), // its articles are gone, no cap
    });

    const { result } = await hydrate(diff, t);

    expect(served.stats.requests.map((r) => r.op)).toEqual(Array(4).fill('GetArticlesForTopicsByIds'));
    expect(result.dailyLimitReached).toBe(false);
    expect(result.insertedCount).toBe(HYDRATE_CHUNK_SIZE * 3);
    expect((await rowsById()).has(all[all.length - 1])).toBe(true);
  });
});

describe('the already-read backfill', () => {
  it('writes a row synced earlier as already read once its story is opened', async () => {
    const first = await prepare(['a000', 'a001']);
    await hydrate(first.diff, first.t);
    expect((await rowsById()).get('a001')!.status).toBe('unscored');
    await recordOpen({ articleId: 'a001', titleNorm: 'unrelated words only', surface: 'feed' });

    // The new article is ineligible, so no gate pass runs: only the persist step's own backfill can mark a001.
    server.use(
      servePersona({ topics: { 'formula 1': ['a000', 'a001', 'b000'] } }),
      ...serveHydrate({ article: noEnglish }).handlers,
    );
    const { diff } = await drive(fetchAndDiff(first.t));
    await hydrate(diff, first.t);

    const rows = await rowsById();
    expect(rows.get('a001')!.status).toBe('already_read');
    expect(rows.get('a000')!.status).toBe('unscored');
  });
});

describe('the tracked-story reconcile with an image', () => {
  it('carries the suggestion image onto the new member snapshot', async () => {
    const subject: FeedbackSubject = {
      origin: 'suggestion',
      surface: 'for_you',
      articleId: 'seed',
      title: 'Seed seed',
      pubDate: new Date('2026-10-09T06:00:00.000Z').toISOString(),
      publicationName: 'Seed Pub',
    };
    await trackStoryWithProposal(subject, { label: 'Label gaza', searchText: 'gaza ceasefire' });
    const story = (await firstValueFrom(observeActive())).find((s) => s.topicText === 'gaza ceasefire')!;
    const topicId = story.topicId as string;
    await persistAndLinkV2Suggestions(
      [art('img1', { image_url: 'https://example.com/img1.jpg' })],
      new Map(),
      { matchedTopics: new Map([['img1', [{ topicId, text: topicId }]]]) },
    );

    await reconcileTrackedStories();

    const snap = (await getTrackedStoryById(story.id))!.memberSnapshots!.find((s) => s.articleId === 'img1')!;
    expect(snap.imageUrl).toBe('https://example.com/img1.jpg');
  });
});
