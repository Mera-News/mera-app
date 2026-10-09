// story-impression-service at its seam: opens-only seen state over the in-memory DB, clock faked.
// Replaces lib/database/services/__tests__/story-impression-service.test.ts, whose database mock
// ignored `Q.where('opened', true)`: it could only prove the JS guard. Here the query is real too.
//
// Only recordOpen writes impressions now. Rows with opened = false are what an older build wrote on
// every scroll-past; they are seeded raw (`seedLegacyImpression`) because no service can.
import {
  deleteOlderThan,
  getAll,
  getOpenedSeenBreakdown,
  getOpenedSeenSet,
  getOpenedTitleNorms,
  recordOpen,
} from '@/lib/database/services/story-impression-service';
import { useStrictClock } from '@/test/helpers';
import { countRows, countWrites, DAY_MS, failNextQuery, quietLogger, restoreFaults, seedLegacyImpression, T0 } from './support';

let log: ReturnType<typeof quietLogger>;
beforeEach(() => {
  useStrictClock(T0);
  log = quietLogger();
});
afterEach(restoreFaults);

const at = (ms: number) => jest.setSystemTime(ms);

async function openAt(ms: number, articleId: string, over: Partial<Parameters<typeof recordOpen>[0]> = {}) {
  at(ms);
  await recordOpen({ articleId, surface: 'feed', ...over });
  at(T0);
}

describe('recordOpen', () => {
  it('writes an opened row with a first and last seen time and a count of one', async () => {
    await recordOpen({
      articleId: 'a1',
      stableClusterId: 'story-1',
      suggestionId: 'sugg-1',
      titleNorm: 'russia summons envoy',
      surface: 'swipe',
    });

    const rows = await getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      articleId: 'a1',
      stableClusterId: 'story-1',
      suggestionId: 'sugg-1',
      titleNorm: 'russia summons envoy',
      surface: 'swipe',
      opened: true,
      seenCount: 1,
    });
    expect(rows[0].firstSeenAt.getTime()).toBe(T0);
    expect(rows[0].lastSeenAt.getTime()).toBe(T0);
  });

  it('stores absent optional fields as null', async () => {
    await recordOpen({ articleId: 'a1', surface: 'feed' });
    expect((await getAll())[0]).toMatchObject({ stableClusterId: null, suggestionId: null, titleNorm: null });
  });

  it('an open of the same article upserts: one row, count and last seen move, first seen stays', async () => {
    await openAt(T0 - 5000, 'a1');
    await openAt(T0, 'a1');

    const rows = await getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].seenCount).toBe(2);
    expect(rows[0].firstSeenAt.getTime()).toBe(T0 - 5000);
    expect(rows[0].lastSeenAt.getTime()).toBe(T0);
    expect(rows[0].opened).toBe(true);
  });

  it('an open upgrades an older scroll-past row in place', async () => {
    await seedLegacyImpression('a1');
    expect((await getOpenedSeenSet()).size).toBe(0);

    await recordOpen({ articleId: 'a1', surface: 'detail' });

    const rows = await getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ opened: true, seenCount: 2 });
    expect((await getOpenedSeenSet()).has('a1')).toBe(true);
  });

  it('backfills the cluster id and title only when they were unknown, and never overwrites them', async () => {
    await recordOpen({ articleId: 'a1', surface: 'feed' });
    await recordOpen({ articleId: 'a1', surface: 'feed', stableClusterId: 'story-1', titleNorm: 'first title' });
    await recordOpen({ articleId: 'a1', surface: 'feed', stableClusterId: 'story-2', titleNorm: 'second title' });

    expect((await getAll())[0]).toMatchObject({ stableClusterId: 'story-1', titleNorm: 'first title', seenCount: 3 });
  });

  it('ignores a blank article id and trims the id it keeps', async () => {
    await recordOpen({ articleId: '   ', surface: 'feed' });
    expect(await countRows('story_impressions')).toBe(0);

    await recordOpen({ articleId: '  a1 ', surface: 'feed' });
    expect((await getAll())[0].articleId).toBe('a1');
  });

  it('captures and swallows a failure', async () => {
    failNextQuery('story_impressions');

    await expect(recordOpen({ articleId: 'a1', surface: 'feed' })).resolves.toBeUndefined();

    expect(log.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { service: 'story-impression', method: 'recordOpen' } }),
    );
    expect(await countRows('story_impressions')).toBe(0);
  });
});

describe('getAll', () => {
  it('returns every impression, scroll-past rows included', async () => {
    await recordOpen({ articleId: 'opened', surface: 'feed' });
    await seedLegacyImpression('scrolled-past');
    expect((await getAll()).map((r) => r.articleId).sort()).toEqual(['opened', 'scrolled-past']);
  });
});

describe('getOpenedSeenSet (opens only)', () => {
  it('holds the opened articles and never a scroll-past one', async () => {
    await recordOpen({ articleId: 'opened1', surface: 'feed' });
    await seedLegacyImpression('impressed1');

    const set = await getOpenedSeenSet();
    expect(set.has('opened1')).toBe(true);
    expect(set.has('impressed1')).toBe(false);
  });

  it('holds both the article id and the cluster id of an opened row, but not a scroll-past row cluster', async () => {
    await recordOpen({ articleId: 'a1', stableClusterId: 'story-1', surface: 'feed' });
    await recordOpen({ articleId: 'a2', surface: 'feed' });
    await seedLegacyImpression('a3', { stableClusterId: 'story-3' });

    expect([...(await getOpenedSeenSet())].sort()).toEqual(['a1', 'a2', 'story-1']);
  });

  it('is empty when nothing was opened', async () => {
    await seedLegacyImpression('x');
    expect((await getOpenedSeenSet()).size).toBe(0);
  });
});

describe('getOpenedTitleNorms (opens only)', () => {
  it('returns the title snapshot of opened rows, skipping blank and missing ones', async () => {
    await recordOpen({ articleId: 'o1', titleNorm: 'russia summons envoy', surface: 'feed' });
    await recordOpen({ articleId: 'o2', titleNorm: '   ', surface: 'feed' });
    await recordOpen({ articleId: 'o3', titleNorm: null, surface: 'feed' });
    await seedLegacyImpression('imp', { titleNorm: 'not seen title' });

    expect(await getOpenedTitleNorms()).toEqual(['russia summons envoy']);
  });
});

describe('getOpenedSeenBreakdown', () => {
  it('splits the axes, and getOpenedSeenSet is exactly their union', async () => {
    await recordOpen({ articleId: 'a1', stableClusterId: 'story-1', surface: 'feed' });
    await recordOpen({ articleId: 'a2', surface: 'feed' });
    await seedLegacyImpression('impressed1', { stableClusterId: 'story-2' });

    const breakdown = await getOpenedSeenBreakdown();
    expect([...breakdown.articleIds].sort()).toEqual(['a1', 'a2']);
    expect([...breakdown.clusterIds]).toEqual(['story-1']);
    expect([...(await getOpenedSeenSet())].sort()).toEqual([...new Set([...breakdown.articleIds, ...breakdown.clusterIds])].sort());
    expect(breakdown.stats).toMatchObject({ rowCount: 2, articleIdCount: 2, clusterIdCount: 1, unionSize: 3 });
  });

  it('a row without a cluster id contributes to the article axis only', async () => {
    await recordOpen({ articleId: 'a1', surface: 'feed' });
    const breakdown = await getOpenedSeenBreakdown();
    expect(breakdown.articleIds.has('a1')).toBe(true);
    expect(breakdown.clusterIds.size).toBe(0);
    expect(breakdown.stats).toMatchObject({ articleIdCount: 1, clusterIdCount: 0 });
  });

  it('unionSize collapses an id that is an article on one row and a cluster on another', async () => {
    await recordOpen({ articleId: 'shared', surface: 'feed' });
    await recordOpen({ articleId: 'a2', stableClusterId: 'shared', surface: 'feed' });
    expect((await getOpenedSeenBreakdown()).stats.unionSize).toBe(2);
  });

  it('is all zeros and nulls with nothing opened', async () => {
    expect((await getOpenedSeenBreakdown()).stats).toEqual({
      rowCount: 0,
      articleIdCount: 0,
      clusterIdCount: 0,
      unionSize: 0,
      oldestFirstSeenAtMs: null,
      newestLastSeenAtMs: null,
      ageBuckets: { le24h: 0, d1to7: 0, d7to30: 0 },
    });
  });

  it('partitions the rows into le24h / d1to7 / d7to30 on each side of the 24h and 7d boundaries', async () => {
    const now = T0;
    await openAt(now - 1_000, 'r1');
    await openAt(now - DAY_MS, 'r2'); // exactly 24h: still le24h
    await openAt(now - DAY_MS - 1, 'r3');
    await openAt(now - 7 * DAY_MS, 'r4'); // exactly 7d: still d1to7
    await openAt(now - 7 * DAY_MS - 1, 'r5');
    await openAt(now - 20 * DAY_MS, 'r6');
    await seedLegacyImpression('r7', { firstSeenAt: now - 1_000 });

    const { stats } = await getOpenedSeenBreakdown(now);
    expect(stats.ageBuckets).toEqual({ le24h: 2, d1to7: 2, d7to30: 2 });
    expect(stats.rowCount).toBe(6);
    expect(stats.ageBuckets.le24h + stats.ageBuckets.d1to7 + stats.ageBuckets.d7to30).toBe(stats.rowCount);
  });

  it('reports the oldest first seen and the newest last seen of the opened rows', async () => {
    await openAt(T0 - 3 * DAY_MS, 'old');
    await openAt(T0 - 1000, 'new');
    await seedLegacyImpression('scrolled', { firstSeenAt: T0 - 20 * DAY_MS });

    const { stats } = await getOpenedSeenBreakdown(T0);
    expect(stats.oldestFirstSeenAtMs).toBe(T0 - 3 * DAY_MS);
    expect(stats.newestLastSeenAtMs).toBe(T0 - 1000);
  });

  it('reads the age against the clock when no now is given', async () => {
    await openAt(T0 - 2 * DAY_MS, 'a1');
    expect((await getOpenedSeenBreakdown()).stats.ageBuckets).toEqual({ le24h: 0, d1to7: 1, d7to30: 0 });
  });
});

describe('deleteOlderThan', () => {
  it('deletes the impressions first seen before the cutoff, returns how many, and keeps the cutoff itself', async () => {
    await openAt(T0 - 31 * DAY_MS, 'old-open');
    await seedLegacyImpression('old-scroll', { firstSeenAt: T0 - 40 * DAY_MS });
    await openAt(T0 - 30 * DAY_MS, 'edge');
    await openAt(T0 - 10 * DAY_MS, 'fresh');

    const removed = await deleteOlderThan(T0 - 30 * DAY_MS);

    expect(removed).toBe(2);
    expect((await getAll()).map((r) => r.articleId).sort()).toEqual(['edge', 'fresh']);
  });

  it('judges by first seen: a recently re-opened old story still goes', async () => {
    await openAt(T0 - 40 * DAY_MS, 'old');
    await openAt(T0, 'old');

    expect(await deleteOlderThan(T0 - 30 * DAY_MS)).toBe(1);
    expect(await countRows('story_impressions')).toBe(0);
  });

  it('opens no write and returns 0 when nothing is older', async () => {
    await openAt(T0 - DAY_MS, 'fresh');
    const writes = countWrites();

    expect(await deleteOlderThan(T0 - 30 * DAY_MS)).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});
