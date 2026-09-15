import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import {
  WINDOW_DAYS,
  WINDOW_MS,
  computeReadingStats,
  emptyReadingStats,
  roundedAverageHours,
  type StatsImpression,
} from '../reading-stats';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function visit(overrides: Partial<VisitedArticle> = {}): VisitedArticle {
  return {
    articleId: 'a1',
    articleSuggestionId: null,
    articleUrl: 'https://example.test/a1',
    publicationName: 'The Hindu',
    countryCode: 'IN',
    titleEn: null,
    titleOriginal: null,
    languageCode: 'en',
    imageUrl: null,
    pubDate: null,
    visitedAt: NOW - HOUR,
    visitCount: 1,
    ...overrides,
  };
}

function impression(overrides: Partial<StatsImpression> = {}): StatsImpression {
  return { articleId: 'a1', opened: true, firstSeenAtMs: NOW - HOUR, ...overrides };
}

describe('computeReadingStats', () => {
  it('returns a clean zero shape for an empty device, with no divide by zero', () => {
    const stats = computeReadingStats({ visits: [], impressions: [], nowMs: NOW });

    expect(stats.publicationCount).toBe(0);
    expect(stats.countryCount).toBe(0);
    expect(stats.articlesOpened).toBe(0);
    expect(stats.topPublications).toEqual([]);
    expect(stats.hasAnyData).toBe(false);
    // null, never 0: zero would read as "published and read in the same
    // instant" rather than "we have no publish times".
    expect(stats.publishToRead.averageHours).toBeNull();
    expect(stats.publishToRead.sampledArticles).toBe(0);
    expect(stats.publishToRead.totalArticles).toBe(0);
    expect(stats.windowDays).toBe(WINDOW_DAYS);
  });

  it('counts distinct publications and distinct countries, not rows', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: 'The Hindu', countryCode: 'IN' }),
        visit({ articleId: 'a2', publicationName: 'The Hindu', countryCode: 'IN' }),
        visit({ articleId: 'a3', publicationName: 'Le Monde', countryCode: 'FR' }),
        visit({ articleId: 'a4', publicationName: 'NHK', countryCode: 'JP' }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(2 + 1);
    expect(stats.countryCount).toBe(3);
    expect(stats.hasAnyData).toBe(true);
  });

  it('ignores blank and whitespace-only publication names and country codes', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: '   ', countryCode: '  ' }),
        visit({ articleId: 'a2', publicationName: 'Le Monde', countryCode: null }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
    expect(stats.countryCount).toBe(0);
    expect(stats.topPublications).toEqual([
      { publicationName: 'Le Monde', countryCode: null, visitCount: 1 },
    ]);
  });

  it('drops visits older than the 30-day window', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'fresh', publicationName: 'Le Monde', visitedAt: NOW - DAY }),
        visit({ articleId: 'stale', publicationName: 'NHK', visitedAt: NOW - WINDOW_MS - 1 }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
    expect(stats.topPublications.map((p) => p.publicationName)).toEqual(['Le Monde']);
  });

  it('keeps a visit exactly on the window boundary', () => {
    const stats = computeReadingStats({
      visits: [visit({ visitedAt: NOW - WINDOW_MS })],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
  });

  it('keeps a visit with a future timestamp rather than silently narrowing the count', () => {
    const stats = computeReadingStats({
      visits: [visit({ visitedAt: NOW + DAY })],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
  });

  describe('publish-to-read coverage', () => {
    it('reports the average alongside BOTH halves of its denominator', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', visitedAt: NOW, pubDate: NOW - 4 * HOUR }),
          visit({ articleId: 'a2', visitedAt: NOW, pubDate: NOW - 8 * HOUR }),
          visit({ articleId: 'a3', visitedAt: NOW, pubDate: null }),
          visit({ articleId: 'a4', visitedAt: NOW, pubDate: null }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.publishToRead.averageHours).toBe(6);
      // The average is over 2 rows; the card must say "2 of 4", never imply 4.
      expect(stats.publishToRead.sampledArticles).toBe(2);
      expect(stats.publishToRead.totalArticles).toBe(4);
    });

    it('returns a null average when no row has a known publish time', () => {
      const stats = computeReadingStats({
        visits: [visit({ pubDate: null }), visit({ articleId: 'a2', pubDate: null })],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.publishToRead.averageHours).toBeNull();
      expect(stats.publishToRead.sampledArticles).toBe(0);
      expect(stats.publishToRead.totalArticles).toBe(2);
    });

    it('computes coverage over the WINDOWED rows, not the raw input', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'fresh', visitedAt: NOW, pubDate: NOW - 2 * HOUR }),
          visit({ articleId: 'stale', visitedAt: NOW - WINDOW_MS - 1, pubDate: NOW - 5 * HOUR }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.publishToRead.totalArticles).toBe(1);
      expect(stats.publishToRead.sampledArticles).toBe(1);
      expect(stats.publishToRead.averageHours).toBe(2);
    });
  });

  describe('articlesOpened', () => {
    it('counts opened impressions only', () => {
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'a1', opened: true }),
          impression({ articleId: 'a2', opened: false }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
      expect(stats.hasAnyData).toBe(true);
    });

    it('applies the 30-day window itself, because the impressions table does not', () => {
      // story_impressions is pruned by a SWEEP (deleteOlderThan from
      // data-cleanup-task), not at query level, so getAll() can hand back rows
      // older than the window whenever that sweep is behind. Counting them would
      // put a false "last 30 days" label on the figure.
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'fresh', firstSeenAtMs: NOW - DAY }),
          impression({ articleId: 'unswept', firstSeenAtMs: NOW - WINDOW_MS - 1 }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
    });

    it('drops a row whose first_seen_at cannot be placed in the window', () => {
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'a1', firstSeenAtMs: null }),
          impression({ articleId: 'a2', firstSeenAtMs: Number.NaN }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(0);
      expect(stats.hasAnyData).toBe(false);
    });

    it('dedupes by article id and ignores blank ids', () => {
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'a1' }),
          impression({ articleId: 'a1' }),
          impression({ articleId: '  ' }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
    });
  });

  describe('topPublications', () => {
    it('sums taps per publication and orders by count, then name', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'NHK', countryCode: 'JP', visitCount: 2 }),
          visit({ articleId: 'a2', publicationName: 'NHK', countryCode: 'JP', visitCount: 3 }),
          visit({ articleId: 'a3', publicationName: 'Le Monde', countryCode: 'FR', visitCount: 5 }),
          visit({ articleId: 'a4', publicationName: 'The Hindu', countryCode: 'IN', visitCount: 1 }),
        ],
        impressions: [],
        nowMs: NOW,
        topPublicationLimit: 3,
      });

      expect(stats.topPublications).toEqual([
        { publicationName: 'Le Monde', countryCode: 'FR', visitCount: 5 },
        { publicationName: 'NHK', countryCode: 'JP', visitCount: 5 },
        { publicationName: 'The Hindu', countryCode: 'IN', visitCount: 1 },
      ]);
    });

    it('keeps same-name publications in different countries apart', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'The Times', countryCode: 'GB', visitCount: 2 }),
          visit({ articleId: 'a2', publicationName: 'The Times', countryCode: 'IN', visitCount: 1 }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.topPublications).toEqual([
        { publicationName: 'The Times', countryCode: 'GB', visitCount: 2 },
        { publicationName: 'The Times', countryCode: 'IN', visitCount: 1 },
      ]);
      // Distinct NAMES, so the headline figure still says one publication.
      expect(stats.publicationCount).toBe(1);
    });

    it('honours the limit and a zero limit', () => {
      const visits = ['a', 'b', 'c', 'd'].map((id, i) =>
        visit({ articleId: id, publicationName: `Pub ${id}`, visitCount: 10 - i }),
      );

      expect(computeReadingStats({ visits, impressions: [], nowMs: NOW }).topPublications).toHaveLength(3);
      expect(
        computeReadingStats({ visits, impressions: [], nowMs: NOW, topPublicationLimit: 0 })
          .topPublications,
      ).toEqual([]);
    });

    it('treats a missing or non-positive visitCount as one tap', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'NHK', visitCount: 0 }),
          visit({ articleId: 'a2', publicationName: 'NHK', visitCount: Number.NaN }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.topPublications[0].visitCount).toBe(2);
    });
  });
});

describe('emptyReadingStats', () => {
  it('matches what the core returns for empty input', () => {
    expect(emptyReadingStats()).toEqual(
      computeReadingStats({ visits: [], impressions: [], nowMs: NOW }),
    );
  });
});

describe('roundedAverageHours', () => {
  it('rounds a real average', () => {
    expect(roundedAverageHours({ averageHours: 8.6, sampledArticles: 3, totalArticles: 5 })).toBe(9);
  });

  it('passes null through rather than turning it into zero', () => {
    expect(roundedAverageHours({ averageHours: null, sampledArticles: 0, totalArticles: 5 })).toBeNull();
  });

  it('floors a negative average at zero', () => {
    // A publish date in the future (a feed with a bad pubDate) would otherwise
    // render "minus 3 hours", which reads as a bug rather than as bad data.
    expect(roundedAverageHours({ averageHours: -3.2, sampledArticles: 1, totalArticles: 1 })).toBe(0);
  });
});
