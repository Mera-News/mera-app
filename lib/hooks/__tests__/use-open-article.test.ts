// use-open-article unit tests — the three routing outcomes of an article tap.
//
// The reason lookup is mocked at the service boundary; the DB-level gate that
// decides WHICH suggestions count as "reasoned" is covered separately in
// lib/database/services/__tests__/article-suggestion-reason-lookup.test.ts.

const mockGetReasonedSuggestionIdForArticle = jest.fn<Promise<string | null>, [string]>();

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getReasonedSuggestionIdForArticle: (articleId: string) =>
    mockGetReasonedSuggestionIdForArticle(articleId),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

import { router } from 'expo-router';
import logger from '@/lib/logger';
import { openArticle } from '../use-open-article';

const push = router.push as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('openArticle', () => {
  it('routes to suggestion-detail when the article has a reasoned suggestion', async () => {
    mockGetReasonedSuggestionIdForArticle.mockResolvedValue('sugg-1');

    await openArticle({ articleId: 'art-1' });

    expect(mockGetReasonedSuggestionIdForArticle).toHaveBeenCalledWith('art-1');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: 'sugg-1' },
    });
  });

  it('routes to article-detail when no reasoned suggestion exists', async () => {
    mockGetReasonedSuggestionIdForArticle.mockResolvedValue(null);

    await openArticle({ articleId: 'art-2' });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/article-detail',
      params: { articleId: 'art-2' },
    });
  });

  it('routes to article-detail (no crash) when the lookup throws', async () => {
    mockGetReasonedSuggestionIdForArticle.mockRejectedValue(new Error('db closed'));

    await expect(openArticle({ articleId: 'art-3' })).resolves.toBeUndefined();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/article-detail',
      params: { articleId: 'art-3' },
    });
    expect(logger.captureException).toHaveBeenCalled();
  });

  it('falls back to article-detail when the lookup outruns its deadline', async () => {
    // Never settles — only the deadline can resolve the race.
    mockGetReasonedSuggestionIdForArticle.mockReturnValue(new Promise<string | null>(() => {}));

    await openArticle({ articleId: 'art-4', timeoutMs: 1 });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/article-detail',
      params: { articleId: 'art-4' },
    });
  });

  it('forwards stableClusterId on the article fallback and drops it on the suggestion path', async () => {
    mockGetReasonedSuggestionIdForArticle.mockResolvedValue(null);
    await openArticle({ articleId: 'art-5', stableClusterId: 'cluster-9' });
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/logged-in/article-detail',
      params: { articleId: 'art-5', stableClusterId: 'cluster-9' },
    });

    mockGetReasonedSuggestionIdForArticle.mockResolvedValue('sugg-5');
    await openArticle({ articleId: 'art-5', stableClusterId: 'cluster-9' });
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: 'sugg-5' },
    });
  });
});
