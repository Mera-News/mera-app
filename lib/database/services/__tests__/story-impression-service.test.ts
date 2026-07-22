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
