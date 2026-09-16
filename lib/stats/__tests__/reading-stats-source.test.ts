import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import { Observable, of } from 'rxjs';

const mockGetAllVisitedArticles = jest.fn();
const mockGetAllImpressions = jest.fn();
const mockLoadSavedItems = jest.fn();
const mockObserveActiveTracked = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getAllVisitedArticles: () => mockGetAllVisitedArticles(),
}));

jest.mock('@/lib/database/services/story-impression-service', () => ({
  getAll: () => mockGetAllImpressions(),
}));

// Both of these MUST be mocked, and not because the assertions need them:
// each pulls in lib/database/index.ts, which constructs the SQLiteAdapter at
// IMPORT time, and the suite then dies on `initializeJSI` with a stack pointing
// at an import line rather than at anything this file does. Adding a service
// import to reading-stats-source.ts without adding its mock here is the whole
// failure mode.
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
  loadSavedItems: () => mockLoadSavedItems(),
}));

jest.mock('@/lib/database/services/tracked-story-service', () => ({
  observeActive: () => mockObserveActiveTracked(),
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
  mockLoadSavedItems.mockReset().mockResolvedValue([]);
  // `of(...)` rather than a bare Promise: the adapter takes the FIRST value off
  // a live query, so the mock has to be an observable or firstValueFrom never
  // settles and the test times out instead of failing.
  mockObserveActiveTracked.mockReset().mockReturnValue(of([]));
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


describe('the present-tense figures', () => {
  it('counts saved items and active followed stories', async () => {
    mockLoadSavedItems.mockResolvedValue([{ origin: 'suggestion' }, { origin: 'article' }]);
    mockObserveActiveTracked.mockReturnValue(of([{ id: 's1' }, { id: 's2' }, { id: 's3' }]));

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.keptNow).toEqual({ savedArticles: 2, followedStories: 3 });
  });

  it('takes the first emission without waiting for a second', async () => {
    // A WatermelonDB observable never completes, so anything that waits for
    // completion hangs here rather than failing. This asserts the read settles
    // at all, which is the thing a timeout would otherwise report as a generic
    // suite failure five seconds later.
    const never = new Observable<unknown[]>((subscriber) => {
      subscriber.next([{ id: 'only' }]);
      // deliberately never completes
    });
    mockObserveActiveTracked.mockReturnValue(never);

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.keptNow.followedStories).toBe(1);
  });

  it('gives an empty card rather than a half-true one when a read fails', async () => {
    // One catch covers all four reads on purpose: a card showing real countries
    // beside a silently-zero saved count is worse than a card that says there
    // is nothing to show.
    mockGetAllVisitedArticles.mockResolvedValue([visit()]);
    mockLoadSavedItems.mockRejectedValue(new Error('saved table unavailable'));

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.hasAnyData).toBe(false);
    expect(stats.publicationCount).toBe(0);
    expect(stats.keptNow).toEqual({ savedArticles: 0, followedStories: 0 });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
