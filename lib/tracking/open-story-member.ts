// Open a followed story's member from its timeline. Same routing as
// `use-open-article` (the reasoned suggestion page when there is a row, else
// the bare article), but the route also carries `trackedStoryId`, so the page
// can list the story's other copies of the article from its own snapshots and
// retention rows, before and after the 48h sweep. Never throws.

import { router } from 'expo-router';
import { getReasonedSuggestionIdForArticle } from '@/lib/database/services/article-suggestion-reads';
import { REASON_LOOKUP_TIMEOUT_MS } from '@/lib/hooks/use-open-article';

export async function openStoryMember(opts: {
  articleId: string;
  trackedStoryId: string;
  stableClusterId?: string | null;
}): Promise<void> {
  const { articleId, trackedStoryId, stableClusterId } = opts;
  let suggestionId: string | null = null;
  try {
    suggestionId = await Promise.race([
      getReasonedSuggestionIdForArticle(articleId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), REASON_LOOKUP_TIMEOUT_MS)),
    ]);
  } catch {
    suggestionId = null;
  }
  if (suggestionId) {
    router.push({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: suggestionId, trackedStoryId },
    });
    return;
  }
  router.push({
    pathname: '/logged-in/article-detail',
    params: stableClusterId ? { articleId, stableClusterId, trackedStoryId } : { articleId, trackedStoryId },
  });
}
