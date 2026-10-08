import type {
  VisitedArticle,
  VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import {
  mergeVisitedByName,
  visitsForNames,
} from '../visited-publications';

const pub = (
  publicationName: string,
  countryCode: string | null,
  visitCount: number,
  lastVisitedAt: number,
): VisitedPublication => ({ publicationName, countryCode, visitCount, lastVisitedAt });

const visit = (publicationName: string, articleId: string, visitedAt: number): VisitedArticle => ({
  articleId,
  articleSuggestionId: null,
  articleUrl: null,
  publicationName,
  countryCode: null,
  titleEn: null,
  titleOriginal: null,
  languageCode: null,
  imageUrl: null,
  pubDate: null,
  visitedAt,
  visitCount: 1,
});

describe('mergeVisitedByName', () => {
  it('merges case, spacing and country variants and sums their counts', () => {
    // Counts above one, aggregated from two or more rows, so a sum cannot be
    // confused with a row count.
    const merged = mergeVisitedByName([
      pub('Der Spiegel', 'DEU', 3, 100),
      pub('DER  SPIEGEL ', 'AUT', 2, 300),
      pub('der spiegel', null, 4, 200),
      pub('TechRadar', 'GBR', 6, 50),
    ]);

    expect(merged).toEqual([
      // 3 + 2 + 4 = 9 beats 6: before the merge TechRadar would have led.
      { publicationName: 'der spiegel', countryCode: null, visitCount: 9, lastVisitedAt: 300 },
      { publicationName: 'TechRadar', countryCode: 'GBR', visitCount: 6, lastVisitedAt: 50 },
    ]);
  });

  it('keeps the name and country of the biggest part, ties to the most recent', () => {
    const merged = mergeVisitedByName([pub('NOS', 'NLD', 2, 10), pub('nos', 'BEL', 2, 20)]);
    expect(merged).toEqual([{ publicationName: 'nos', countryCode: 'BEL', visitCount: 4, lastVisitedAt: 20 }]);
  });

  it('breaks count ties by the most recent visit and drops blank names', () => {
    const merged = mergeVisitedByName([pub('A', null, 2, 10), pub('  ', null, 9, 99), pub('B', null, 2, 20)]);
    expect(merged.map((r) => r.publicationName)).toEqual(['B', 'A']);
  });

  it('does not mutate its input', () => {
    const rows = [pub('A', null, 2, 10), pub('a', null, 3, 20)];
    mergeVisitedByName(rows);
    expect(rows[0].visitCount).toBe(2);
  });
});

describe('visitsForNames', () => {
  const visits = [
    visit('The Guardian', 'g1', 300),
    visit('BBC News', 'b1', 200),
    visit('the  guardian', 'g2', 100),
  ];

  it('matches every known name, normalised, keeping order', () => {
    expect(visitsForNames(visits, ['THE GUARDIAN', null]).map((v) => v.articleId)).toEqual(['g1', 'g2']);
    expect(visitsForNames(visits, ['Guardian News', 'BBC News']).map((v) => v.articleId)).toEqual(['b1']);
  });

  it('returns nothing when no name is known', () => {
    expect(visitsForNames(visits, [undefined, ' '])).toEqual([]);
  });
});

describe('calendarDaysAgo', () => {
  const { calendarDaysAgo } = require('../visited-publications') as typeof import('../visited-publications');
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime();
  it('counts calendar days, not 24h spans', () => {
    expect(calendarDaysAgo(at(2026, 9, 6, 23, 50), at(2026, 9, 7, 0, 10))).toBe(1);
    expect(calendarDaysAgo(at(2026, 9, 7, 0, 5), at(2026, 9, 7, 23, 55))).toBe(0);
    expect(calendarDaysAgo(at(2026, 8, 28, 12), at(2026, 9, 7, 12))).toBe(9);
  });
});
