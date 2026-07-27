// story-impression-service — opens-only seen-state readers (Wave 7b-core M-P5b).
// WatermelonDB I/O is intercepted via makeDatabaseMock(); the fake query IGNORES
// the Q.where predicate and returns every row set, so these tests verify the
// service's own JS `opened === true` guard keeps the seen set OPENS-ONLY.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  getOpenedSeenSet,
  getOpenedSeenBreakdown,
  getOpenedTitleNorms,
} from '../story-impression-service';

const db = database as any;
const TABLE = 'story_impressions';

function row(o: Record<string, unknown>) {
  return makeRecord({
    articleId: 'art',
    stableClusterId: null,
    titleNorm: null,
    opened: false,
    ...o,
  });
}

beforeEach(() => {
  db._setRows(TABLE, []);
});

describe('getOpenedSeenSet (opens-only)', () => {
  it('includes only OPENED rows — impressions are excluded', () => {
    db._setRows(TABLE, [
      row({ articleId: 'opened1', opened: true }),
      row({ articleId: 'impressed1', opened: false }), // impression → NOT seen
    ]);
    return getOpenedSeenSet().then((set) => {
      expect(set.has('opened1')).toBe(true);
      expect(set.has('impressed1')).toBe(false);
    });
  });

  it('adds both article_id and stable_cluster_id of opened rows', () => {
    db._setRows(TABLE, [
      row({ articleId: 'a1', stableClusterId: 'story-1', opened: true }),
      row({ articleId: 'a2', stableClusterId: null, opened: true }),
    ]);
    return getOpenedSeenSet().then((set) => {
      expect([...set].sort()).toEqual(['a1', 'a2', 'story-1']);
    });
  });

  it('empty when nothing opened', () => {
    db._setRows(TABLE, [row({ articleId: 'x', opened: false })]);
    return getOpenedSeenSet().then((set) => expect(set.size).toBe(0));
  });
});

describe('getOpenedTitleNorms (opens-only fallback)', () => {
  it('returns snapshotted title_norm of opened rows only, skipping blanks', () => {
    db._setRows(TABLE, [
      row({ articleId: 'o1', opened: true, titleNorm: 'russia summons envoy' }),
      row({ articleId: 'o2', opened: true, titleNorm: '   ' }), // blank → skipped
      row({ articleId: 'o3', opened: true, titleNorm: null }), // null → skipped
      row({ articleId: 'imp', opened: false, titleNorm: 'not seen title' }),
    ]);
    return getOpenedTitleNorms().then((norms) => {
      expect(norms).toEqual(['russia summons envoy']);
    });
  });
});

describe('REGRESSION: getOpenedSeenSet still excludes opened=false rows', () => {
  it('excludes impression-only rows even when they coexist with opened rows', () => {
    db._setRows(TABLE, [
      row({ articleId: 'opened1', opened: true }),
      row({ articleId: 'impressed1', opened: false }),
    ]);
    return getOpenedSeenSet().then((set) => {
      expect(set.has('opened1')).toBe(true);
      expect(set.has('impressed1')).toBe(false);
    });
  });
});

describe('getOpenedSeenBreakdown', () => {
  it('getOpenedSeenSet() equals the union of the breakdown articleIds and clusterIds', () => {
    db._setRows(TABLE, [
      row({ articleId: 'a1', stableClusterId: 'story-1', opened: true }),
      row({ articleId: 'a2', stableClusterId: null, opened: true }),
      row({ articleId: 'impressed1', opened: false }), // excluded from both
    ]);
    return Promise.all([getOpenedSeenSet(), getOpenedSeenBreakdown()]).then(
      ([set, breakdown]) => {
        const union = new Set([...breakdown.articleIds, ...breakdown.clusterIds]);
        expect([...set].sort()).toEqual([...union].sort());
      },
    );
  });

  it('the r.opened !== true guard still filters under the predicate-ignoring mock', () => {
    db._setRows(TABLE, [
      row({ articleId: 'opened1', stableClusterId: 'story-1', opened: true }),
      row({ articleId: 'impressed1', stableClusterId: 'story-2', opened: false }),
    ]);
    return getOpenedSeenBreakdown().then((breakdown) => {
      expect(breakdown.articleIds.has('opened1')).toBe(true);
      expect(breakdown.clusterIds.has('story-1')).toBe(true);
      expect(breakdown.articleIds.has('impressed1')).toBe(false);
      expect(breakdown.clusterIds.has('story-2')).toBe(false);
      expect(breakdown.stats.rowCount).toBe(1);
    });
  });

  it('rows with a null stableClusterId contribute to articleIds only', () => {
    db._setRows(TABLE, [
      row({ articleId: 'a1', stableClusterId: null, opened: true }),
    ]);
    return getOpenedSeenBreakdown().then((breakdown) => {
      expect(breakdown.articleIds.has('a1')).toBe(true);
      expect(breakdown.clusterIds.size).toBe(0);
      expect(breakdown.stats.articleIdCount).toBe(1);
      expect(breakdown.stats.clusterIdCount).toBe(0);
    });
  });

  it('unionSize matches the size of articleIds ∪ clusterIds', () => {
    db._setRows(TABLE, [
      // 'shared' appears as both an article id on one row and a cluster id on
      // another, so the union collapses to 2 distinct keys, not 3.
      row({ articleId: 'shared', stableClusterId: null, opened: true }),
      row({ articleId: 'a2', stableClusterId: 'shared', opened: true }),
    ]);
    return getOpenedSeenBreakdown().then((breakdown) => {
      const union = new Set([...breakdown.articleIds, ...breakdown.clusterIds]);
      expect(breakdown.stats.unionSize).toBe(union.size);
      expect(breakdown.stats.unionSize).toBe(2);
    });
  });

  describe('stats.ageBuckets partitions rowCount exactly', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const nowMs = 1_700_000_000_000;

    it('splits rows into le24h / d1to7 / d7to30 on each side of the 24h and 7d boundaries', () => {
      db._setRows(TABLE, [
        // le24h: well within a day, and exactly at the 24h boundary (inclusive).
        row({ articleId: 'r1', opened: true, firstSeenAt: nowMs - 1_000 }),
        row({ articleId: 'r2', opened: true, firstSeenAt: nowMs - DAY_MS }),
        // d1to7: just over the 24h boundary, and exactly at the 7d boundary (inclusive).
        row({ articleId: 'r3', opened: true, firstSeenAt: nowMs - DAY_MS - 1 }),
        row({ articleId: 'r4', opened: true, firstSeenAt: nowMs - 7 * DAY_MS }),
        // d7to30: just over the 7d boundary, and deep into the 30-day range.
        row({ articleId: 'r5', opened: true, firstSeenAt: nowMs - 7 * DAY_MS - 1 }),
        row({ articleId: 'r6', opened: true, firstSeenAt: nowMs - 20 * DAY_MS }),
        // Excluded from every bucket — not opened.
        row({ articleId: 'r7', opened: false, firstSeenAt: nowMs - 1_000 }),
      ]);
      return getOpenedSeenBreakdown(nowMs).then((breakdown) => {
        expect(breakdown.stats.ageBuckets).toEqual({ le24h: 2, d1to7: 2, d7to30: 2 });
        expect(breakdown.stats.rowCount).toBe(6);
        const bucketTotal =
          breakdown.stats.ageBuckets.le24h +
          breakdown.stats.ageBuckets.d1to7 +
          breakdown.stats.ageBuckets.d7to30;
        expect(bucketTotal).toBe(breakdown.stats.rowCount);
      });
    });
  });
});
