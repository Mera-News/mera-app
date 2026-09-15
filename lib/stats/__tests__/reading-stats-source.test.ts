import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';

const mockGetAllVisitedArticles = jest.fn();
const mockGetAllImpressions = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getAllVisitedArticles: () => mockGetAllVisitedArticles(),
}));

jest.mock('@/lib/database/services/story-impression-service', () => ({
  getAll: () => mockGetAllImpressions(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: (...args: unknown[]) => mockCaptureException(...args) },
}));

import { WINDOW_MS } from '../reading-stats';
import { loadReadingStats } from '../reading-stats-source';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function visit(overrides: Partial<VisitedArticle> = {}): VisitedArticle {
  return {
    articleId: 'a1',
    articleSuggestionId: null,
    articleUrl: null,
    publicationName: 'Le Monde',
    countryCode: 'FR',
    titleEn: null,
    titleOriginal: null,
    languageCode: 'fr',
    imageUrl: null,
    pubDate: NOW - 3 * HOUR,
    visitedAt: NOW - HOUR,
    visitCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetAllVisitedArticles.mockReset().mockResolvedValue([]);
  mockGetAllImpressions.mockReset().mockResolvedValue([]);
  mockCaptureException.mockReset();
});

describe('loadReadingStats', () => {
  it('maps rows into the pure core and returns its result', async () => {
    mockGetAllVisitedArticles.mockResolvedValue([visit()]);
    mockGetAllImpressions.mockResolvedValue([
      { articleId: 'a1', opened: true, firstSeenAt: new Date(NOW - HOUR) },
    ]);

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.publicationCount).toBe(1);
    expect(stats.countryCount).toBe(1);
    expect(stats.articlesOpened).toBe(1);
    // visitedAt NOW-1h minus pubDate NOW-3h = 2 hours of publish-to-read latency.
    expect(stats.publishToRead.averageHours).toBe(2);
    expect(stats.publishToRead.sampledArticles).toBe(1);
    expect(stats.publishToRead.totalArticles).toBe(1);
    expect(stats.hasAnyData).toBe(true);
  });

  it('accepts a raw-number first_seen_at as well as a Date', async () => {
    mockGetAllImpressions.mockResolvedValue([
      { articleId: 'a1', opened: true, firstSeenAt: NOW - HOUR },
      { articleId: 'a2', opened: true, firstSeenAt: new Date(NOW - HOUR) },
    ]);

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.articlesOpened).toBe(2);
  });

  it('treats an unusable first_seen_at as out of window rather than counting it', async () => {
    mockGetAllImpressions.mockResolvedValue([
      { articleId: 'a1', opened: true, firstSeenAt: null },
      { articleId: 'a2', opened: true, firstSeenAt: new Date(NOW - WINDOW_MS - 1) },
      { articleId: 'a3', opened: true, firstSeenAt: undefined },
      { articleId: 'a4', opened: true, firstSeenAt: 'not a date' },
    ]);

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.articlesOpened).toBe(0);
  });

  it('normalises a non-boolean opened flag to false', async () => {
    mockGetAllImpressions.mockResolvedValue([
      { articleId: 'a1', opened: 1, firstSeenAt: new Date(NOW - HOUR) },
    ]);

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.articlesOpened).toBe(0);
  });

  it('passes the top-publication limit through', async () => {
    mockGetAllVisitedArticles.mockResolvedValue([
      visit({ articleId: 'a1', publicationName: 'A' }),
      visit({ articleId: 'a2', publicationName: 'B' }),
    ]);

    const stats = await loadReadingStats({ nowMs: NOW, topPublicationLimit: 1 });

    expect(stats.topPublications).toHaveLength(1);
  });

  it('defaults nowMs to the clock when the caller does not inject one', async () => {
    mockGetAllVisitedArticles.mockResolvedValue([visit({ visitedAt: Date.now() - HOUR })]);

    const stats = await loadReadingStats();

    expect(stats.publicationCount).toBe(1);
  });

  it('returns the empty shape and reports when a read throws', async () => {
    mockGetAllVisitedArticles.mockRejectedValue(new Error('db gone'));

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.hasAnyData).toBe(false);
    expect(stats.publicationCount).toBe(0);
    expect(stats.publishToRead.averageHours).toBeNull();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { service: 'reading-stats', method: 'loadReadingStats' } }),
    );
  });
});
