// stepHydratePersistEnqueue with the foreground enqueue switched ON: the step hands its rows to the
// real scoring pipeline, which submits to the gateway mock (async jobs, real E2EE both ways). This
// is the one place in the feed-sync step tests where scoring runs; every other file suppresses it.
// The pipeline is reset through its own _resetForTests; its limiter, model-fallback and
// attestation caches through theirs.
// Replaces the enqueue, tail-flush, on-device and gate blocks of
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

import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { HYDRATE_CHUNK_SIZE } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import logger from '@/lib/logger';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  advanceUntilDone,
  assertNoGatewayViolations,
  attestationRequests,
  gatewayCalls,
  server,
} from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  fetchAndDiff,
  foreground,
  ids,
  makeCtx,
  resetFeedSyncMemory,
  resetScoringWorld,
  rowsById,
  scoredIds,
  seedInterest,
  seedLocation,
  servePersona,
  serveHydrate,
  spyOnExport,
  hydrate,
  tick,
  tickUntilScored,
} from './support';

beforeEach(async () => {
  resetFeedSyncMemory();
  await resetScoringWorld();
});
afterEach(() => {
  cleanupFeedSync();
  assertNoGatewayViolations();
});

async function prepare(topicIds: string[]) {
  await seedInterest('I follow racing', ['formula 1']);
  server.use(servePersona({ topics: { 'formula 1': topicIds } }), ...serveHydrate().handlers);
  const t = makeCtx();
  const { diff } = await advanceUntilDone(fetchAndDiff(t));
  return { t, diff };
}


describe('the foreground enqueue', () => {
  it('hands exactly the persisted, eligible articles to the scoring pipeline, which submits them to the gateway', async () => {
    const all = ids(12);
    const { t, diff } = await prepare(all);

    const { result } = await foreground(t, diff);
    await tickUntilScored(all.length);

    expect(result.enqueuedCount).toBe(12);
    expect([...result.eligibleIds].sort()).toEqual(all);
    expect(scoredIds().sort()).toEqual(all);
    expect(new Set(gatewayCalls('job').map((c) => c.headers['idempotency-key'])).size).toBeGreaterThan(0);
  });

  it('flushes the trailing partial the gate held back once the whole lot is hydrated', async () => {
    // 7 ids: one batch of 5 goes at once, the 2 left over are under the dispatch floor and wait
    const all = ids(pipeline.MIN_DISPATCH + 2);
    const { t, diff } = await prepare(all);

    await foreground(t, diff);
    await tickUntilScored(all.length);

    expect(scoredIds().sort()).toEqual(all);
  });

  it('never submits a row with no English text: it is tombstoned at hydrate', async () => {
    const all = ids(6);
    const served = serveHydrate({
      article: (id) => (id === 'a002' ? art(id, { description_en: undefined, title_en: undefined }) : art(id)),
    });
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': all } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));

    await foreground(t, diff);
    await tickUntilScored(5);

    expect(scoredIds().sort()).toEqual(all.filter((id) => id !== 'a002'));
  });
});

describe('the gate and enqueue run per chunk, not once at the end', () => {
  it('has a pipeline run for the first chunk while the second is still being fetched', async () => {
    const all = ids(HYDRATE_CHUNK_SIZE + 5);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await seedInterest('I follow racing', ['formula 1']);
    server.use(
      servePersona({ topics: { 'formula 1': all } }),
      ...serveHydrate({ gate: ({ ids: asked }) => (asked.includes(all[all.length - 1]) ? held : undefined) }).handlers,
    );
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));
    let settled = false;
    const run = hydrate(diff, t, { suppressEnqueue: false, background: false }).finally(() => {
      settled = true;
    });

    for (let i = 0; i < 400 && !(await getPipeline()); i++) await jest.advanceTimersByTimeAsync(50);

    expect(settled).toBe(false);
    expect(await getPipeline()).not.toBeNull();
    release();
    await advanceUntilDone(run);
  });

  it('leaves rows already in a live run alone: a later sync enqueues only its own new rows', async () => {
    const first = ids(12);
    const one = await prepare(first);
    await foreground(one.t, one.diff);
    await tickUntilScored(first.length);

    const second = ids(6, 'z');
    server.use(servePersona({ topics: { 'formula 1': [...first, ...second] } }));
    const { diff } = await advanceUntilDone(fetchAndDiff(one.t));
    const { result } = await foreground(one.t, diff);
    await tickUntilScored(first.length + second.length);

    expect(result.enqueuedCount).toBe(second.length);
    const sent = scoredIds();
    expect(new Set(sent).size).toBe(sent.length); // nothing scored twice
    expect(new Set(sent)).toEqual(new Set([...first, ...second]));
  });
});

describe('a server that still caps downloads', () => {
  it('enqueues what landed; the empty chunk is just shorter', async () => {
    const all = ids(HYDRATE_CHUNK_SIZE + 5);
    await seedInterest('I follow racing', ['formula 1']);
    const last = all[all.length - 1];
    server.use(
      servePersona({ topics: { 'formula 1': all } }),
      ...serveHydrate({
        respond: ({ ids: asked }) =>
          asked.includes(last) ? { articles: [], dailyLimitReached: true, resetAt: '2026-06-26T00:00:00.000Z' } : undefined,
      }).handlers,
    );
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));

    const { result } = await foreground(t, diff);
    await tickUntilScored(HYDRATE_CHUNK_SIZE);

    expect(result).toMatchObject({ insertedCount: HYDRATE_CHUNK_SIZE, enqueuedCount: HYDRATE_CHUNK_SIZE });
    expect(scoredIds().sort()).toEqual(all.slice(0, HYDRATE_CHUNK_SIZE));
  });
});

describe('suppressed enqueue', () => {
  it('hands the rows over in the tail flush when the pipeline is idle', async () => {
    const all = ids(pipeline.MIN_DISPATCH + 2);
    const { t, diff } = await prepare(all);

    const { result } = await foreground(t, diff, { suppressEnqueue: true });
    await tickUntilScored(all.length);

    expect(result.enqueuedCount).toBe(0);
    expect(scoredIds().sort()).toEqual(all);
  });

  it('reports a failing tail flush and still returns the hydrated rows', async () => {
    const { t, diff } = await prepare(ids(7));
    spyOnExport(pipeline, 'enqueueUnscoredEligible').mockRejectedValueOnce(new Error('flush failed'));

    const { result } = await foreground(t, diff, { suppressEnqueue: true });

    expect(result.insertedCount).toBe(7);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'flush failed' }),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'tailFlush' }) }),
    );
    expect(scoredIds()).toEqual([]);
  });

  it('leaves the rows to the running pipeline when a scoring run is already in flight', async () => {
    const first = ids(12);
    const one = await prepare(first);
    await foreground(one.t, one.diff);
    await tickUntilScored(first.length);
    expect(await pipeline.getPipelineStatus()).toBe('running');
    const before = scoredIds().length;

    const later = ids(6, 'z');
    server.use(servePersona({ topics: { 'formula 1': later } }));
    const { diff } = await advanceUntilDone(fetchAndDiff(one.t));
    const { result } = await foreground(one.t, diff, { suppressEnqueue: true });
    await tick();

    expect(result.eligibleIds.sort()).toEqual(later);
    expect(scoredIds()).toHaveLength(before);
    expect((await rowsById()).get('z000')!.status).toBe('unscored');
  });
});

describe('on-device scoring', () => {
  it('hydrates and persists but enqueues nothing to the cloud pipeline and flushes no tail', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const all = ids(7);
    const { t, diff } = await prepare(all);

    const { result } = await foreground(t, diff);
    await tick();

    expect(result.enqueuedCount).toBe(0);
    expect([...result.eligibleIds].sort()).toEqual(all);
    expect((await rowsById()).size).toBe(7);
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
    expect(await pipeline.getPipelineStatus()).toBe('idle');
  });
});

describe('which sibling of a duplicate pair is scored', () => {
  const STORY = 'harbour bridge repairs begin in fixtureville after months of planning delays';
  const twin = (id: string, country: string) =>
    art(id, { title_en: `Story ${id} ${STORY}`, title: `Story ${id} ${STORY}`, country_code: country });

  async function syncPair(homeCountry: string) {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation(homeCountry, 0.9, 'home');
    const served = serveHydrate({ article: (id) => twin(id, id.startsWith('nl') ? 'NLD' : 'USA') });
    server.use(
      servePersona({
        headlines: [{ scope: 'GLOBAL', ids: ['nl1', 'us1'] }],
        stable: { nl1: 'one-story', us1: 'one-story' },
      }),
      ...served.handlers,
    );
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));
    await foreground(t, diff);
    await tickUntilScored(1);
    await tick();
  }

  it('scores the copy from the reader home country and holds the other back', async () => {
    await syncPair('NL');

    // only the elected copy was ever sent; the other inherited its verdict
    expect(scoredIds()).toEqual(['nl1']);
    const rows = await rowsById();
    expect(rows.get('us1')!.status).not.toBe('unscored');
    expect(rows.get('us1')!.relevance).toBe(rows.get('nl1')!.relevance);
    expect(rows.get('nl1')!.relevance).toBeGreaterThan(0);
  });

  it('scores the other copy when the reader lives in the other country', async () => {
    await syncPair('US');

    expect(scoredIds()).toEqual(['us1']);
  });
});
