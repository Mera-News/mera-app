// dashboard-section-selector — pure selector tests. RN-free.
//
// Fixture-building follows the fact-rows-selector.test.ts pattern: a minimal
// `sugg()` ForYouSuggestion factory + a `group()` FactRowGroup factory built
// on top of it (only the fields `compareByPriority`/`isGroupNew` actually read
// are varied per-test; the rest get stable defaults).

import {
  compareByPriority,
  selectTopGroups,
  isGroupNew,
  countNewGroups,
  SECTION_PREVIEW_COUNT,
} from '../dashboard-section-selector';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { FactRowGroup } from '../fact-rows-selector';
import type { ForYouSuggestion } from '../for-you-store';

const NOW = 1_000_000_000_000; // fixed clock
const H = 3_600_000;

let seq = 0;
function sugg(id: string): ForYouSuggestion {
  seq += 1;
  return {
    _id: id,
    articleId: `art-${id}`,
    clusters: [],
    relevance: 0.6,
    reason: 'because',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: 'en',
    publication_name: 'Pub',
    title_en: null,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW - H).toISOString(),
    firstPubDate: new Date(NOW - H).toISOString(),
    rawScore: 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
  };
}

function group(o: {
  id?: string;
  rawScore?: number | null;
  highPriority?: boolean;
  createdAtMs?: number;
  addedMs?: number;
  pubDateMs?: number;
}): FactRowGroup {
  const id = o.id ?? `g${seq}`;
  return {
    data: sugg(id),
    members: [],
    rawScore: o.rawScore === undefined ? 0.5 : o.rawScore,
    bucket: 'MEDIUM',
    pubDateMs: o.pubDateMs ?? NOW - H,
    addedMs: o.addedMs ?? NOW - H,
    createdAtMs: o.createdAtMs ?? NOW - H,
    highPriority: o.highPriority ?? false,
  };
}

// --- compareByPriority / selectTopGroups -----------------------------------

describe('compareByPriority', () => {
  it('highPriority beats a higher rawScore non-highPriority group', () => {
    const hp = group({ id: 'hp', highPriority: true, rawScore: 0.1 });
    const nonHp = group({ id: 'nonhp', highPriority: false, rawScore: 0.9 });
    expect(compareByPriority(hp, nonHp)).toBeLessThan(0);
    expect([nonHp, hp].sort(compareByPriority).map((g) => g.data._id)).toEqual(['hp', 'nonhp']);
  });

  it('orders by rawScore desc among equal highPriority', () => {
    const hi = group({ id: 'hi', rawScore: 0.9 });
    const lo = group({ id: 'lo', rawScore: 0.2 });
    expect([lo, hi].sort(compareByPriority).map((g) => g.data._id)).toEqual(['hi', 'lo']);
  });

  it('rawScore: null sorts after any number', () => {
    const withScore = group({ id: 'scored', rawScore: -5 }); // even a very low real score...
    const nullScore = group({ id: 'null', rawScore: null }); // ...beats null.
    expect([nullScore, withScore].sort(compareByPriority).map((g) => g.data._id)).toEqual([
      'scored',
      'null',
    ]);
  });

  it('breaks rawScore ties on createdAtMs desc', () => {
    const older = group({ id: 'older', rawScore: 0.5, createdAtMs: NOW - 5 * H });
    const newer = group({ id: 'newer', rawScore: 0.5, createdAtMs: NOW - 1 * H });
    expect([older, newer].sort(compareByPriority).map((g) => g.data._id)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('breaks full ties on stable id (data._id) asc', () => {
    const b = group({ id: 'b', rawScore: 0.5, createdAtMs: NOW - H });
    const a = group({ id: 'a', rawScore: 0.5, createdAtMs: NOW - H });
    expect([b, a].sort(compareByPriority).map((g) => g.data._id)).toEqual(['a', 'b']);
  });
});

describe('selectTopGroups', () => {
  it('limit defaults to SECTION_PREVIEW_COUNT (3)', () => {
    expect(SECTION_PREVIEW_COUNT).toBe(3);
    const groups = [
      group({ id: 'g1', rawScore: 0.9 }),
      group({ id: 'g2', rawScore: 0.8 }),
      group({ id: 'g3', rawScore: 0.7 }),
      group({ id: 'g4', rawScore: 0.6 }),
      group({ id: 'g5', rawScore: 0.5 }),
    ];
    const top = selectTopGroups(groups);
    expect(top.map((g) => g.data._id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('respects an explicit limit', () => {
    const groups = [
      group({ id: 'g1', rawScore: 0.9 }),
      group({ id: 'g2', rawScore: 0.8 }),
      group({ id: 'g3', rawScore: 0.7 }),
    ];
    expect(selectTopGroups(groups, 1).map((g) => g.data._id)).toEqual(['g1']);
  });

  it('fewer than the limit groups → all returned', () => {
    const groups = [group({ id: 'only1' }), group({ id: 'only2' })];
    const top = selectTopGroups(groups);
    expect(top).toHaveLength(2);
    expect(top.map((g) => g.data._id).sort()).toEqual(['only1', 'only2']);
  });

  it('does not mutate the input array (original order preserved)', () => {
    const groups = [
      group({ id: 'z', rawScore: 0.1 }),
      group({ id: 'a', rawScore: 0.9 }),
      group({ id: 'm', rawScore: 0.5 }),
    ];
    const originalOrder = groups.map((g) => g.data._id);
    selectTopGroups(groups);
    expect(groups.map((g) => g.data._id)).toEqual(originalOrder);
  });
});

// --- isGroupNew / countNewGroups --------------------------------------------

describe('isGroupNew', () => {
  it('addedMs === lastVisitedMs → false (not strictly newer)', () => {
    const g = group({ id: 'g', addedMs: NOW });
    expect(isGroupNew(g, NOW)).toBe(false);
  });

  it('addedMs > lastVisitedMs → true', () => {
    const g = group({ id: 'g', addedMs: NOW });
    expect(isGroupNew(g, NOW - 1)).toBe(true);
  });

  it('addedMs < lastVisitedMs → false', () => {
    const g = group({ id: 'g', addedMs: NOW - 10 });
    expect(isGroupNew(g, NOW)).toBe(false);
  });

  it('undefined lastVisitedMs (never visited) → false, to avoid badge-spam at rollout', () => {
    const g = group({ id: 'g', addedMs: NOW });
    expect(isGroupNew(g, undefined)).toBe(false);
  });
});

describe('countNewGroups', () => {
  it('counts only groups newer than lastVisitedMs in a mixed set', () => {
    const groups = [
      group({ id: 'old1', addedMs: NOW - 3 * H }),
      group({ id: 'new1', addedMs: NOW - H }),
      group({ id: 'boundary', addedMs: NOW - 2 * H }), // === lastVisited, not new
      group({ id: 'new2', addedMs: NOW }),
    ];
    expect(countNewGroups(groups, NOW - 2 * H)).toBe(2);
  });

  it('undefined lastVisitedMs → 0', () => {
    const groups = [group({ id: 'a', addedMs: NOW }), group({ id: 'b', addedMs: NOW })];
    expect(countNewGroups(groups, undefined)).toBe(0);
  });

  it('empty groups → 0', () => {
    expect(countNewGroups([], NOW)).toBe(0);
  });
});
