// use-feed-bootstrap — the shared initial-load bootstrap for the personalized
// feed, extracted from ForYouScreen so BOTH the Dashboard tab and the new Feed
// tab can mount it. Two responsibilities:
//   1. Opened-story set hydration (on mount + on every refocus) so opens
//      recorded on other surfaces dim/exclude here too.
//   2. First-visit persona fetch: when the store is empty, fetch the user
//      persona and set `hasGeneratedTopics`. Returns `{ isLoading, errorMessage }`
//      for the caller's empty-state chain.
//
// DOUBLE-MOUNT SAFE: the persona fetch is guarded by a MODULE-LEVEL in-flight
// key (the two feed tabs stay mounted simultaneously under NativeTabs, so both
// call this hook). Only one fetch runs per user id; a different user id (re-login)
// is allowed through once the first settles.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsFocused } from '@react-navigation/native';
import { authClient } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { getForYouActions } from '@/lib/stores/selectors';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useUserStore } from '@/lib/stores/user-store';

/** Module-level guard: the user id whose bootstrap fetch is currently running,
 *  or null. Shared across every mount of this hook this session. */
let inFlightUserId: string | null = null;

export interface FeedBootstrapState {
  isLoading: boolean;
  errorMessage: string | null;
}

export function useFeedBootstrap(): FeedBootstrapState {
  const { t } = useTranslation();
  const { data: session } = authClient.useSession();
  const { fetchUserPersona } = useUserStore();
  const isFocused = useIsFocused();

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Hydrate the opened-story set once on mount; refresh on every refocus so
  // opens recorded on other surfaces reflect here too.
  useEffect(() => {
    void useOpenedStoriesStore.getState().hydrate();
  }, []);
  useEffect(() => {
    if (isFocused) void useOpenedStoriesStore.getState().hydrate();
  }, [isFocused]);

  // First-visit persona fetch — only when the store is empty (first visit /
  // after logout). Idempotent + double-mount safe via the module-level guard.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    if (useForYouStore.getState().suggestions.length > 0) return;
    if (inFlightUserId === userId) return; // another mount is already bootstrapping this user

    inFlightUserId = userId;
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);

    (async () => {
      try {
        const persona = await fetchUserPersona(userId);
        const hasInterests = !!(
          persona?._id &&
          persona?.userTopics &&
          persona.userTopics.length > 0
        );
        getForYouActions().setHasGeneratedTopics(hasInterests);
      } catch (error: any) {
        logger.captureException(error, {
          tags: { hook: 'use-feed-bootstrap', method: 'bootstrap' },
          extra: { userId },
        });
        if (!cancelled) {
          const isNetworkError =
            error?.networkError ||
            error?.message?.includes('Network request failed');
          setErrorMessage(
            isNetworkError ? t('errors.networkError') : t('errors.feedError'),
          );
        }
      } finally {
        inFlightUserId = null;
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  return { isLoading, errorMessage };
}
