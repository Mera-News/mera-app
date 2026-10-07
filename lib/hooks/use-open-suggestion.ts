// use-open-suggestion — the shared "open a suggestion" handler. Optimistically
// dims the story (opened-stories store), persists the open impression, and
// navigates to the suggestion-detail route. Extracted verbatim from
// ForYouScreen/FactFeedScreen so every surface records opens identically; the
// only difference is the `surface` tag passed at the call site.

import { useCallback } from 'react';
import { InteractionManager } from 'react-native';
import { router } from 'expo-router';
import { authClient } from '@/lib/auth-client';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import type { ImpressionSurface } from '@/lib/database/models/StoryImpression';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useUserStore } from '@/lib/stores/user-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/**
 * Returns a stable callback that opens a `ForYouSuggestion`: mark-opened +
 * record-open (tagged with `surface`) + push to the detail route.
 */
export function useOpenSuggestion(surface: ImpressionSurface) {
  const { data: session } = authClient.useSession();

  return useCallback(
    (suggestion: ForYouSuggestion) => {
      const stableClusterId =
        suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;

      const userPersonaId = useUserStore.getState().userPersona?._id || '';
      router.push({
        pathname: '/logged-in/suggestion-detail',
        params: {
          articleSuggestionId: suggestion._id,
          userId: session?.user?.id || '',
          userPersonaId,
        },
      });

      // Defer the dim + impression bookkeeping past navigation so the
      // synchronous markOpened (which triggers Dashboard's buildFactRows
      // recompute + list re-renders) doesn't block the push and cause tap lag.
      InteractionManager.runAfterInteractions(() => {
        // Optimistically dim the story.
        useOpenedStoriesStore.getState().markOpened(suggestion.articleId, stableClusterId);

        void recordOpen({
          articleId: suggestion.articleId,
          suggestionId: suggestion._id,
          stableClusterId,
          titleNorm:
            (suggestion.title_en ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null,
          surface,
        });
      });
    },
    [surface, session?.user?.id],
  );
}
