// reading-history-export unit tests — no DB/React Native involved, this
// module is pure shaping/statistics over an already-fetched VisitedArticle[].

import {
  READING_HISTORY_WINDOW_DAYS,
  computePublishToReadStats,
  buildReadingHistoryExport,
} from '../reading-history-export';
import type { VisitedArticle } from '../database/services/publication-visit-service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1700000000000;

function makeVisit(overrides: Partial<VisitedArticle> = {}): VisitedArticle {
  return {
    articleId: 'article-1',
    articleSuggestionId: 'sugg-1',
    articleUrl: 'https://example.com/1',
    publicationName: 'The Times',
    countryCode: 'GB',
    titleEn: 'English Title',
    titleOriginal: 'Original Title',
    languageCode: 'en',
    imageUrl: null,
    pubDate: NOW - 6 * HOUR,
    visitedAt: NOW,
    visitCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computePublishToReadStats — the null-pubDate coverage path
// ---------------------------------------------------------------------------

describe('computePublishToReadStats', () => {
  it('returns null average with zero sample size for an empty history', () => {
    const result = computePublishToReadStats([]);
    expect(result).toEqual({ averageHours: null, sampledArticles: 0, totalArticles: 0 });
  });

  it('returns null average when every row has a null pubDate', () => {
    const visits = [
      makeVisit({ pubDate: null }),
      makeVisit({ articleId: 'article-2', pubDate: null }),
    ];
    const result = computePublishToReadStats(visits);
    expect(result.averageHours).toBeNull();
    expect(result.sampledArticles).toBe(0);
    expect(result.totalArticles).toBe(2);
  });

  it('averages only over rows with a known pubDate, reporting the coverage denominator explicitly', () => {
    const visits = [
      makeVisit({ articleId: 'article-1', pubDate: NOW - 2 * HOUR, visitedAt: NOW }), // 2h
      makeVisit({ articleId: 'article-2', pubDate: NOW - 6 * HOUR, visitedAt: NOW }), // 6h
      makeVisit({ articleId: 'article-3', pubDate: null }), // excluded from the average
    ];
    const result = computePublishToReadStats(visits);
    expect(result.averageHours).toBe(4); // (2 + 6) / 2
    expect(result.sampledArticles).toBe(2);
    expect(result.totalArticles).toBe(3); // denominator still reflects ALL rows
  });

  it('computes a single-article average correctly', () => {
    const visits = [makeVisit({ pubDate: NOW - 10 * HOUR, visitedAt: NOW })];
    const result = computePublishToReadStats(visits);
    expect(result.averageHours).toBe(10);
    expect(result.sampledArticles).toBe(1);
    expect(result.totalArticles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildReadingHistoryExport
// ---------------------------------------------------------------------------

describe('buildReadingHistoryExport', () => {
  const now = new Date(NOW);

  it('handles the empty-history path: zero articles, null date range, null average', () => {
    const result = buildReadingHistoryExport([], { now });

    expect(result.totalArticles).toBe(0);
    expect(result.earliestVisit).toBeNull();
    expect(result.latestVisit).toBeNull();
    expect(result.publishToReadStats).toEqual({ averageHours: null, sampledArticles: 0, totalArticles: 0 });
    expect(result.byPublication).toEqual([]);
    expect(result.byCountry).toEqual([]);
    expect(result.byLanguage).toEqual([]);
    expect(result.articles).toEqual([]);
  });

  it('always reports the 30-day hard ceiling regardless of what data is passed in', () => {
    const result = buildReadingHistoryExport([makeVisit()], { now });
    expect(result.windowDays).toBe(READING_HISTORY_WINDOW_DAYS);
    expect(result.windowDays).toBe(30);
    expect(result.windowNote).toMatch(/30 days/);
  });

  it('stamps exportedAt from the injected clock', () => {
    const result = buildReadingHistoryExport([], { now });
    expect(result.exportedAt).toBe(now.toISOString());
  });

  it('defaults exportedAt to the real clock when no `now` is injected', () => {
    const before = Date.now();
    const result = buildReadingHistoryExport([]);
    const after = Date.now();
    const stamped = new Date(result.exportedAt).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('sorts articles newest-visit-first and reports earliest/latest visit', () => {
    const older = makeVisit({ articleId: 'a1', visitedAt: NOW - 2 * DAY, pubDate: NOW - 3 * DAY });
    const newer = makeVisit({ articleId: 'a2', visitedAt: NOW, pubDate: NOW - HOUR });
    const middle = makeVisit({ articleId: 'a3', visitedAt: NOW - DAY, pubDate: null });

    const result = buildReadingHistoryExport([older, newer, middle], { now });

    expect(result.articles.map((a) => a.readAt)).toEqual([
      new Date(NOW).toISOString(),
      new Date(NOW - DAY).toISOString(),
      new Date(NOW - 2 * DAY).toISOString(),
    ]);
    expect(result.earliestVisit).toBe(new Date(NOW - 2 * DAY).toISOString());
    expect(result.latestVisit).toBe(new Date(NOW).toISOString());
  });

  it('maps publishedAt/publishToReadHours to null for rows with an unknown pubDate', () => {
    const visit = makeVisit({ pubDate: null });
    const result = buildReadingHistoryExport([visit], { now });
    expect(result.articles[0].publishedAt).toBeNull();
    expect(result.articles[0].publishToReadHours).toBeNull();
  });

  it('computes publishToReadHours per article when pubDate is known', () => {
    const visit = makeVisit({ pubDate: NOW - 3 * HOUR, visitedAt: NOW });
    const result = buildReadingHistoryExport([visit], { now });
    expect(result.articles[0].publishToReadHours).toBe(3);
    expect(result.articles[0].publishedAt).toBe(new Date(NOW - 3 * HOUR).toISOString());
  });

  it('groups byPublication, byCountry, byLanguage and sorts each by count descending', () => {
    const visits = [
      makeVisit({ articleId: 'a1', publicationName: 'BBC', countryCode: 'GB', languageCode: 'en' }),
      makeVisit({ articleId: 'a2', publicationName: 'BBC', countryCode: 'GB', languageCode: 'en' }),
      makeVisit({ articleId: 'a3', publicationName: 'Le Monde', countryCode: 'FR', languageCode: 'fr' }),
    ];
    const result = buildReadingHistoryExport(visits, { now });

    expect(result.byPublication[0]).toEqual({ publicationName: 'BBC', countryCode: 'GB', count: 2 });
    expect(result.byPublication[1]).toEqual({ publicationName: 'Le Monde', countryCode: 'FR', count: 1 });

    expect(result.byCountry[0]).toEqual({ countryCode: 'GB', count: 2 });
    expect(result.byCountry[1]).toEqual({ countryCode: 'FR', count: 1 });

    expect(result.byLanguage[0]).toEqual({ languageCode: 'en', count: 2 });
    expect(result.byLanguage[1]).toEqual({ languageCode: 'fr', count: 1 });
  });

  it('omits null countryCode/languageCode rows from their respective breakdowns', () => {
    const visits = [makeVisit({ countryCode: null, languageCode: null })];
    const result = buildReadingHistoryExport(visits, { now });
    expect(result.byCountry).toEqual([]);
    expect(result.byLanguage).toEqual([]);
    // The publication itself is still counted even with a null country.
    expect(result.byPublication).toEqual([{ publicationName: 'The Times', countryCode: null, count: 1 }]);
  });

  it('carries the overall publishToReadStats through to the export payload', () => {
    const visits = [
      makeVisit({ articleId: 'a1', pubDate: NOW - 4 * HOUR, visitedAt: NOW }),
      makeVisit({ articleId: 'a2', pubDate: null }),
    ];
    const result = buildReadingHistoryExport(visits, { now });
    expect(result.publishToReadStats).toEqual({ averageHours: 4, sampledArticles: 1, totalArticles: 2 });
  });
});
