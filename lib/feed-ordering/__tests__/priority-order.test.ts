// priority-order — THE shared ordering rule (Feed tab + Dashboard sections).
// Pure: no RN/DB. The Feed's own projection is covered by
// components/custom/feed/__tests__/feed-entries.test.ts; this pins the rule
// itself so the two surfaces cannot drift.

import {
  countUnviewedBy,
  isViewedArticle,
  relevanceBandRank,
  sortByPriority,
  type PriorityFacts,
} from '../priority-order';

describe('relevanceBandRank', () => {
  it('mirrors the getRelevanceColors thresholds', () => {
    expect(relevanceBandRank(1.2)).toBe(0); // emergency
    expect(relevanceBandRank(0.9)).toBe(1); // high
    expect(relevanceBandRank(0.77)).toBe(1); // inclusive edge
    expect(relevanceBandRank(0.6)).toBe(2); // medium
    expect(relevanceBandRank(0.53)).toBe(2); // inclusive edge
    expect(relevanceBandRank(0.4)).toBe(3); // low
    expect(relevanceBandRank(0.3)).toBe(4); // exclusive edge → irrelevant
    expect(relevanceBandRank(0)).toBe(4);
  });
});

describe('isViewedArticle', () => {
  it('is true on a dwell/interaction card state', () => {
    expect(isViewedArticle('row-1', 'art-1', { 'row-1': { state: 'skipped' } }, new Set())).toBe(true);
  });

  it('is true on an exact-article open', () => {
    expect(isViewedArticle('row-1', 'art-1', {}, new Set(['art-1']))).toBe(true);
  });

  it('is false when neither signal is present', () => {
    expect(isViewedArticle('row-1', 'art-1', {}, new Set(['art-other']))).toBe(false);
  });

  // The two keys are different NAMESPACES: card states are keyed by feed-order
  // row id, the opened set by article id. Collapsing them flips which set each
  // lookup hits — this is the regression that caught it.
  it('does not look up the row id in the opened set', () => {
    expect(isViewedArticle('row-1', 'art-1', {}, new Set(['row-1']))).toBe(false);
  });

  it('does not look up the article id in the card states', () => {
    expect(isViewedArticle('row-1', 'art-1', { 'art-1': {} }, new Set())).toBe(false);
  });

  it('tolerates missing keys', () => {
    expect(isViewedArticle(null, null, {}, new Set())).toBe(false);
    expect(isViewedArticle(undefined, 'art-1', {}, new Set(['art-1']))).toBe(true);
  });
});

describe('sortByPriority', () => {
  const facts = (relevance: number, viewed: boolean): PriorityFacts => ({ relevance, viewed });
  type Row = { id: string; relevance: number; viewed: boolean };
  const project = (r: Row) => facts(r.relevance, r.viewed);
  const row = (id: string, relevance: number, viewed = false): Row => ({ id, relevance, viewed });
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  it('orders unviewed by band, high to low', () => {
    const out = sortByPriority([row('low', 0.4), row('high', 0.9), row('med', 0.6)], project);
    expect(ids(out)).toEqual(['high', 'med', 'low']);
  });

  it('puts every unviewed above every viewed, whatever the relevance', () => {
    const out = sortByPriority(
      [row('viewed-high', 0.9, true), row('unviewed-low', 0.4)],
      project,
    );
    expect(ids(out)).toEqual(['unviewed-low', 'viewed-high']);
  });

  it('bands within each block: unviewed high→low, then viewed high→low', () => {
    const out = sortByPriority(
      [
        row('u-low', 0.4),
        row('v-high', 0.9, true),
        row('u-high', 0.85),
        row('v-low', 0.35, true),
        row('u-med', 0.6),
        row('v-med', 0.55, true),
      ],
      project,
    );
    expect(ids(out)).toEqual(['u-high', 'u-med', 'u-low', 'v-high', 'v-med', 'v-low']);
  });

  it('keeps the incoming order within a band (explicit index tie-break)', () => {
    const out = sortByPriority([row('a', 0.6), row('b', 0.6), row('c', 0.6)], project);
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input and drops nothing', () => {
    const input = [row('a', 0.4), row('b', 0.9, true), row('c', 0.6)];
    const snapshot = ids(input);
    const out = sortByPriority(input, project);
    expect(ids(input)).toEqual(snapshot);
    expect([...ids(out)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an empty input', () => {
    expect(sortByPriority([], project)).toEqual([]);
  });
});

describe('countUnviewedBy', () => {
  it('counts only the unviewed', () => {
    const rows = [
      { relevance: 0.6, viewed: false },
      { relevance: 0.9, viewed: true },
      { relevance: 0.4, viewed: false },
    ];
    expect(countUnviewedBy(rows, (r) => r)).toBe(2);
    expect(countUnviewedBy([], (r: PriorityFacts) => r)).toBe(0);
  });
});
