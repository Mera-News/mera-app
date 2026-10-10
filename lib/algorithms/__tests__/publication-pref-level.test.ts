// publication-pref-level: pure, so no database mock is needed (and none may be
// needed: list rows import this module).

import { normalizePrefName, publisherPrefNames, resolvePrefLevel } from '../publication-pref-level';

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

  it('fewer wins over more, whatever the row order', () => {
    expect(resolvePrefLevel([row('A', 0.5), row('B', -0.5)], ['A', 'B'])).toBe('deprioritised');
    expect(resolvePrefLevel([row('B', -0.5), row('A', 0.5)], ['A', 'B'])).toBe('deprioritised');
  });

  it('a mute reads as deprioritised', () => {
    expect(resolvePrefLevel([row('A', -1)], ['A'])).toBe('deprioritised');
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
