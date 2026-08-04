// local-article-snapshot — the article-detail screen's local fallbacks.
//
// These matter because an external news URL is now reachable from exactly ONE
// place, a detail screen: that is where the read/translate block lives, and
// every list surface navigates here rather than opening the publisher page
// itself. A detail screen that dead-ends therefore costs the reader the article
// AND the translation.
//
// The dead end is the COMMON case for old stories: server articles are dropped
// after 48h while this device's read history keeps 30 days, so most rows in the
// per-publication history point at an article `articleById` returns null for.

const mockGetSavedSuggestionByServerId = jest.fn();
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
  getSavedSuggestionByServerId: (...a: any[]) => mockGetSavedSuggestionByServerId(...a),
}));

const mockGetVisitedArticleById = jest.fn();
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitedArticleById: (...a: any[]) => mockGetVisitedArticleById(...a),
}));

import { findLocalArticleSnapshot } from '../local-article-snapshot';

const makeVisit = (overrides: Record<string, unknown> = {}) => ({
  articleId: 'art-1',
  articleSuggestionId: null,
  articleUrl: 'https://zeit.de/story',
  publicationName: 'Die Zeit',
  countryCode: 'DEU',
  titleEn: 'English headline',
  titleOriginal: 'Deutsche Schlagzeile',
  languageCode: 'de',
  imageUrl: 'https://zeit.de/i.jpg',
  pubDate: 1700000000000,
  visitedAt: 1700000100000,
  visitCount: 1,
  ...overrides,
});

const makeSaved = (overrides: Record<string, unknown> = {}) => ({
  _id: 'art-1',
  articleId: 'art-1',
  title_en: 'Saved headline',
  title_original: 'Saved original',
  description_en: 'desc',
  article_url: 'https://zeit.de/saved',
  image_url: null,
  language_code: 'de',
  publication_name: 'Die Zeit',
  country_code: 'DEU',
  firstPubDate: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSavedSuggestionByServerId.mockResolvedValue(null);
  mockGetVisitedArticleById.mockResolvedValue(null);
});

describe('findLocalArticleSnapshot', () => {
  it('returns null when this device holds nothing for the article', async () => {
    expect(await findLocalArticleSnapshot('art-1')).toBeNull();
  });

  it('prefers a saved row and does not even look at the visit log', async () => {
    mockGetSavedSuggestionByServerId.mockResolvedValue(makeSaved());
    const result = await findLocalArticleSnapshot('art-1');
    expect(result?.source).toBe('saved');
    expect(result?.article.article_url).toBe('https://zeit.de/saved');
    expect(mockGetVisitedArticleById).not.toHaveBeenCalled();
  });

  it('falls back to the read history, carrying the URL and source language', async () => {
    mockGetVisitedArticleById.mockResolvedValue(makeVisit());
    const result = await findLocalArticleSnapshot('art-1');
    expect(result?.source).toBe('visit');
    // These two are what ReadTranslateActions runs on — without them the
    // detail screen cannot offer the translate options, which is the whole
    // reason every surface routes here.
    expect(result?.article.article_url).toBe('https://zeit.de/story');
    expect(result?.article.original_language_code).toBe('de');
    expect(result?.article.title_en_internal_only).toBe('English headline');
    expect(result?.article.publicationSource?.publication_name).toBe('Die Zeit');
  });

  it('ignores a visit row with no URL — there would be nothing to read or translate', async () => {
    mockGetVisitedArticleById.mockResolvedValue(makeVisit({ articleUrl: null }));
    expect(await findLocalArticleSnapshot('art-1')).toBeNull();
  });

  it('keeps a saved row with no URL — that path is for offline READING', async () => {
    mockGetSavedSuggestionByServerId.mockResolvedValue(makeSaved({ article_url: null }));
    const result = await findLocalArticleSnapshot('art-1');
    expect(result?.source).toBe('saved');
  });

  it('looks both stores up by the article id it was given', async () => {
    await findLocalArticleSnapshot('art-42');
    expect(mockGetSavedSuggestionByServerId).toHaveBeenCalledWith('art-42');
    expect(mockGetVisitedArticleById).toHaveBeenCalledWith('art-42');
  });
});
