// publication-pref-level: pure, so no database mock is needed (and none may be
// needed: list rows import this module).

import { isStarInherited, normalizePrefName, publisherPrefNames, resolvePrefLevel } from '../publication-pref-level';

describe('normalizePrefName', () => {
  it('lowercases, trims and collapses inner whitespace', () => {
    expect(normalizePrefName('  The   Hindu ')).toBe('the hindu');
  });
});

describe('publisherPrefNames', () => {
  it('dedupes on the normalized form, keeps the first spelling, drops empties', () => {
    expect(publisherPrefNames(['Times of India', 'times  of india'], 'TOI', null, undefined, '  ', ['TOI '])).toEqual([
      'Times of India',
      'TOI',
    ]);
  });
});

describe('resolvePrefLevel', () => {
  const row = (publicationName: string, weight: number, extra: Record<string, unknown> = {}) => ({
    publicationName,
    weight,
    scopeKind: null,
    status: 'active',
    ...extra,
  });

  it('is none without names or rows', () => {
    expect(resolvePrefLevel([], ['A'])).toBe('none');
    expect(resolvePrefLevel([row('A', 0.5)], [])).toBe('none');
  });

  it('reads any of the names, normalized', () => {
    expect(resolvePrefLevel([row('toi  business', 0.5)], ['Times of India', 'TOI Business'])).toBe('prioritised');
  });

  it('a mute wins over a preference, whatever the row order', () => {
    expect(resolvePrefLevel([row('A', 0.5), row('B', -1)], ['A', 'B'])).toBe('muted');
    expect(resolvePrefLevel([row('B', -1), row('A', 0.5)], ['A', 'B'])).toBe('muted');
  });

  it('a stored fewer reads as neither state', () => {
    expect(resolvePrefLevel([row('A', -0.5)], ['A'])).toBe('none');
    expect(resolvePrefLevel([row('A', -0.5), row('B', 0.5)], ['A', 'B'])).toBe('prioritised');
  });

  it('ignores country scopes, retired rows, other names and neutral weights', () => {
    const rows = [
      row('India', -0.5, { scopeKind: 'country' }),
      row('A', -0.5, { status: 'retired' }),
      row('Other', -0.5),
      row('A', 0),
    ];
    expect(resolvePrefLevel(rows, ['A', 'India'])).toBe('none');
  });
});

describe('isStarInherited', () => {
  const india = { publicationName: 'India', weight: 0.5, scopeKind: 'country', scopeValue: 'IND', status: 'active' };
  const named = (weight: number) => ({ publicationName: 'A', weight, scopeKind: null, status: 'active' });

  it('is true for a publication with no row of its own in a preferred country', () => {
    expect(isStarInherited([india], ['A'], 'IND')).toBe(true);
    expect(isStarInherited([india], ['A'], ' ind ')).toBe(true);
  });

  it('is false in another country, with no country, and for a lowered or retired country', () => {
    expect(isStarInherited([india], ['A'], 'DEU')).toBe(false);
    expect(isStarInherited([india], ['A'], null)).toBe(false);
    expect(isStarInherited([{ ...india, weight: -0.5 }], ['A'], 'IND')).toBe(false);
    expect(isStarInherited([{ ...india, status: 'retired' }], ['A'], 'IND')).toBe(false);
  });

  it('a row of its own wins, a stored Fewer included', () => {
    expect(isStarInherited([india, named(0.5)], ['A'], 'IND')).toBe(false);
    expect(isStarInherited([named(-1), india], ['A'], 'IND')).toBe(false);
    expect(isStarInherited([india, named(-0.5)], ['A'], 'IND')).toBe(false);
    expect(isStarInherited([india, { ...named(-1), status: 'retired' }], ['A'], 'IND')).toBe(true);
  });
});
