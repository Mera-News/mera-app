import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import {
  buildActivityShareText,
  countryRows,
  filterVisits,
  freshnessBands,
  languageRows,
} from '@/lib/stats/activity';

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();

const visit = (over: Partial<VisitedArticle>): VisitedArticle => ({
  articleId: 'a',
  articleSuggestionId: null,
  articleUrl: null,
  publicationName: 'Le Monde',
  countryCode: 'FRA',
  titleEn: null,
  titleOriginal: null,
  languageCode: 'fr',
  imageUrl: null,
  pubDate: null,
  visitedAt: NOW,
  // Re-opens never weigh a figure here: every count is articles.
  visitCount: 5,
  ...over,
});

describe('freshnessBands', () => {
  it('bands publish-to-read age at 1h, 6h, 24h and 3 days, and counts the rows with no publish time apart', () => {
    const ages = [0.2, -0.5, 1, 5.9, 6, 23.9, 24, 71.9, 72, 500];
    const visits = [
      ...ages.map((h, i) => visit({ articleId: `a${i}`, pubDate: NOW - h * HOUR })),
      visit({ articleId: 'none-1', pubDate: null }),
      visit({ articleId: 'none-2', pubDate: null }),
    ];
    // Under an hour (a future publish time too), 1-6h, 6-24h, 1-3 days, older.
    expect(freshnessBands(visits)).toEqual({ counts: [2, 2, 2, 2, 2], sampled: 10, total: 12 });
  });

  it('is all zeros on no rows', () => {
    expect(freshnessBands([])).toEqual({ counts: [0, 0, 0, 0, 0], sampled: 0, total: 0 });
  });
});

describe('countryRows', () => {
  it('counts distinct publications by normalised name and articles per country, most articles first', () => {
    const rows = countryRows([
      visit({ articleId: '1', publicationName: 'Le Monde', countryCode: 'FRA' }),
      visit({ articleId: '2', publicationName: 'LE  MONDE', countryCode: 'FRA' }),
      visit({ articleId: '3', publicationName: 'Libération', countryCode: 'FRA' }),
      visit({ articleId: '4', publicationName: 'NRC', countryCode: 'NLD' }),
      visit({ articleId: '5', publicationName: 'Nowhere', countryCode: null }),
    ]);
    expect(rows).toEqual([
      { countryCode: 'FRA', publications: 2, articles: 3 },
      { countryCode: 'NLD', publications: 1, articles: 1 },
    ]);
  });
});

describe('languageRows', () => {
  it('lists every language with its articles and share of the articles that carry one', () => {
    const rows = languageRows([
      visit({ articleId: '1', languageCode: 'fr' }),
      visit({ articleId: '2', languageCode: 'fr' }),
      visit({ articleId: '3', languageCode: 'fr' }),
      visit({ articleId: '4', languageCode: 'nl' }),
      visit({ articleId: '5', languageCode: null }),
    ]);
    expect(rows).toEqual([
      { languageCode: 'fr', articles: 3, share: 0.75 },
      { languageCode: 'nl', articles: 1, share: 0.25 },
    ]);
  });
});

describe('filterVisits', () => {
  const today = visit({ articleId: 't', languageCode: 'fr', visitedAt: NOW });
  const yesterdayNl = visit({ articleId: 'y', languageCode: 'nl', visitedAt: NOW - 24 * HOUR });
  const yesterdayFr = visit({ articleId: 'y2', languageCode: 'fr', visitedAt: NOW - 25 * HOUR });

  it('keeps one local day, one language, or both', () => {
    const all = [today, yesterdayNl, yesterdayFr];
    expect(filterVisits(all, { day: '2026-10-19' })).toEqual([yesterdayNl, yesterdayFr]);
    expect(filterVisits(all, { language: 'fr' })).toEqual([today, yesterdayFr]);
    expect(filterVisits(all, { day: '2026-10-19', language: 'fr' })).toEqual([yesterdayFr]);
    expect(filterVisits(all, {})).toEqual(all);
  });
});

describe('buildActivityShareText', () => {
  it('is the heading, the lines, then the footer and the privacy line, split by blank lines', () => {
    expect(buildActivityShareText('History', ['A: 2 visits', 'B: 1 visit'], 'Shared via x', 'Counted on my phone.')).toBe(
      'History\n\nA: 2 visits\nB: 1 visit\n\nShared via x\n\nCounted on my phone.',
    );
  });
});
