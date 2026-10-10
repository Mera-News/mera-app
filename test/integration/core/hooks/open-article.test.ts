// openArticle / useOpenArticle: the three routing outcomes of an article tap, over the real
// article_suggestions table on the in-memory DB. Replaces lib/hooks/__tests__/use-open-article.test.ts
// (which mocked the reason lookup). The DB-level gate that decides WHICH rows count as "reasoned" is
// the lookup's own concern; here a row is reasoned when the scorer wrote a note for it.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { renderHook } from '@testing-library/react-native';
import { router } from 'expo-router';
import database from '@/lib/database';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import { REASON_LOOKUP_TIMEOUT_MS, openArticle, useOpenArticle } from '@/lib/hooks/use-open-article';
import logger from '@/lib/logger';
import { useStrictClock } from '@/test/helpers';
import { seedArticles, suggestionRows } from '../sync/seed';

const push = router.push as unknown as jest.Mock;

// A note must share a word with the article's title or the scorer drops it as ungrounded.
const NOTE = 'Formula racing fans will like this season opener.';

/** Seeds one article and returns its local suggestion id; `reason` null leaves it unscored. */
async function seedSuggestion(articleId: string, reason: string | null): Promise<string> {
  await seedArticles([{ id: articleId, title: 'Formula racing season opener' }]);
  const rows = Object.values(await suggestionRows()).filter((r) => r.articleId === articleId);
  expect(rows).toHaveLength(1);
  const id = rows[0]._id;
  if (reason !== null) await saveScoringResult(id, { relevance: 0.9, reason, reasonSkipped: reason === '' });
  return id;
}

const detail = (articleId: string, stableClusterId?: string) => ({
  pathname: '/logged-in/article-detail',
  params: stableClusterId ? { articleId, stableClusterId } : { articleId },
});

describe('openArticle', () => {
  it('routes to suggestion-detail when the article has a reasoned suggestion', async () => {
    const id = await seedSuggestion('art-1', NOTE);

    await openArticle({ articleId: 'art-1' });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: id },
    });
  });

  it('routes to article-detail when the suggestion has no reason', async () => {
    await seedSuggestion('art-2', '');

    await openArticle({ articleId: 'art-2' });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(detail('art-2'));
  });

  it('routes to article-detail when the article has no local suggestion at all', async () => {
    await openArticle({ articleId: 'never-synced' });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(detail('never-synced'));
  });

  it('ignores an excluded suggestion even when it carries a reason', async () => {
    const id = await seedSuggestion('art-x', NOTE);
    const row = await database.get<ArticleSuggestionModel>('article_suggestions').find(id);
    await database.write(async () => {
      await row.update((r) => {
        r.status = ArticleSuggestionStatus.Excluded;
      });
    });

    await openArticle({ articleId: 'art-x' });

    expect(push).toHaveBeenCalledWith(detail('art-x'));
  });

  it('routes to article-detail (no crash) when the lookup throws, and reports it', async () => {
    const col = database.get('article_suggestions');
    const spy = jest.spyOn(col, 'query').mockImplementationOnce(() => {
      throw new Error('db closed');
    });

    try {
      await expect(openArticle({ articleId: 'art-3' })).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(detail('art-3'));
    expect(logger.captureException).toHaveBeenCalledTimes(1);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { articleId: 'art-3' } }),
    );
  });

  it('forwards stableClusterId on the article fallback and drops it on the suggestion path', async () => {
    await openArticle({ articleId: 'art-5', stableClusterId: 'cluster-9' });
    expect(push).toHaveBeenLastCalledWith(detail('art-5', 'cluster-9'));

    const id = await seedSuggestion('art-6', NOTE);
    await openArticle({ articleId: 'art-6', stableClusterId: 'cluster-9' });
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: id },
    });
  });

  describe('deadline', () => {
    beforeEach(() => useStrictClock('2026-10-08T12:00:00Z'));

    it('falls back to article-detail exactly when the lookup outruns REASON_LOOKUP_TIMEOUT_MS', async () => {
      // A lookup that never settles: only the deadline can resolve the race.
      const col = database.get('article_suggestions');
      const spy = jest.spyOn(col, 'query').mockImplementationOnce(
        () => ({ fetch: () => new Promise(() => {}) }) as never,
      );

      try {
        const tapped = openArticle({ articleId: 'art-4' });
        await jest.advanceTimersByTimeAsync(REASON_LOOKUP_TIMEOUT_MS - 1);
        expect(push).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        await tapped;
      } finally {
        spy.mockRestore();
      }

      expect(REASON_LOOKUP_TIMEOUT_MS).toBe(120);
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(detail('art-4'));
      expect(logger.captureException).not.toHaveBeenCalled();
    });

    it('a lookup that answers in time clears its deadline timer', async () => {
      const id = await seedSuggestion('art-7', NOTE);
      const tapped = openArticle({ articleId: 'art-7' });
      await jest.advanceTimersByTimeAsync(0);
      await tapped;

      expect(push).toHaveBeenCalledWith({
        pathname: '/logged-in/suggestion-detail',
        params: { articleSuggestionId: id },
      });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe('useOpenArticle', () => {
  it('returns one stable fire-and-forget callback that navigates', async () => {
    const { result, rerender } = renderHook(() => useOpenArticle());
    const first = result.current;
    rerender({});
    expect(result.current).toBe(first);

    expect(first({ articleId: 'art-8' })).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(push).toHaveBeenCalledWith(detail('art-8'));
  });
});
