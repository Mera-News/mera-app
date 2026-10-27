// openArticle carries trackedStoryId on both routes (the reason page and the bare article).
import { router } from 'expo-router';
import { openArticle } from '@/lib/hooks/use-open-article';
import { seedScored } from '../grouping/seed';

const push = router.push as jest.Mock;

describe('openArticle trackedStoryId', () => {
  it('rides the bare article route', async () => {
    await openArticle({ articleId: 'nope', stableClusterId: 'sc1', trackedStoryId: 't1' });
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/article-detail',
      params: { articleId: 'nope', stableClusterId: 'sc1', trackedStoryId: 't1' },
    });
  });

  it('rides the reason route and is absent when not given', async () => {
    await seedScored({ id: 'a1' }, { relevance: 0.8, reason: 'a reason old' });
    await openArticle({ articleId: 'a1', trackedStoryId: 't1' });
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: 'a1', trackedStoryId: 't1' },
    });
    await openArticle({ articleId: 'a1' });
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: 'a1' },
    });
  });
});
