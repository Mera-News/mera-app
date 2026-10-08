// Every number in the Feed's stats sentence is the last 24 hours (owner):
// the analysed / relevant / read counts share the server's published window,
// while the feed itself keeps listing rows up to 48h old.
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { COUNTS_WINDOW_MS, computeFeedCounts } from '../use-feed-counts';

jest.mock('@/lib/stores/selectors', () => ({ useForYouCounts: jest.fn(), useForYouSuggestions: jest.fn() }));
jest.mock('@/lib/stores/opened-stories-store', () => ({ useOpenedStoriesStore: jest.fn() }));

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 3_600_000;
const row = (id: string, hoursAgo: number, relevance: number, status: string = ArticleSuggestionStatus.Complete) => ({
  articleId: id,
  status,
  relevance,
  firstPubDate: new Date(NOW - hoursAgo * HOUR).toISOString(),
});

describe('computeFeedCounts', () => {
  it('uses the same 24 hours as the published count', () => {
    expect(COUNTS_WINDOW_MS).toBe(24 * HOUR);
  });

  it('counts only rows published in the last 24 hours', () => {
    const rows = [
      row('a', 1, 0.9),
      row('b', 23.9, 0.1),
      row('c', 24.1, 0.9), // still in the 48h feed, not in the counts
      row('d', 40, 0.9),
      row('e', 2, 0.9, ArticleSuggestionStatus.Unscored),
    ];
    const counts = computeFeedCounts(rows, { nowMs: NOW, openedArticleIds: new Set(['a', 'c']) });
    expect(counts).toEqual({ analysedCount: 2, relevantCount: 1, readCount: 1 });
  });
});
