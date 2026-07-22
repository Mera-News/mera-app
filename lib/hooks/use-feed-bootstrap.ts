// use-feed-bootstrap — the shared initial-load bootstrap for the personalized
// feed, extracted from ForYouScreen so BOTH the Dashboard tab and the new Feed
// tab can mount it. Two responsibilities:
//   1. Opened-story set hydration (on mount + on every refocus) so opens
//      recorded on other surfaces dim/exclude here too.
//   2. First-visit persona fetch + local `hasGeneratedTopics` derivation: when
//      the store is empty, fetch the user persona (still needed to hydrate
//      onboarding stage / blocked-by-LLM / notification state into the store)
//      and, on a successful fetch, set `hasGeneratedTopics` from the on-device
//      `topics` table — the app owns the authoritative topic list locally, so
//      the server's (retired) userTopics linkage is no longer the source of
//      truth. Returns `{ isLoading, errorMessage }` for the caller's
//      empty-state chain.
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
import { getActive } from '@/lib/database/services/topic-service';

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
  const { fetchUserPersonaOrThrow } = useUserStore();
  const isFocused = useIsFocused();
  // Reactive subscription: a persisted-false flag (e.g. from a prior transient
  // failure, before this fix, or a confirmed-empty persona) must retrigger the
  // fetch on a later tab visit rather than being sticky for the session.
  const hasGeneratedTopics = useForYouStore((s) => s.hasGeneratedTopics);

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

  // Self-heal persona fetch — runs when the store is empty (first visit /
  // after logout) OR the persisted hasGeneratedTopics flag is false (a prior
  // fetch never confirmed interests, whether from a transient error or a
  // stale false). Idempotent + double-mount safe via the module-level guard,
  // and rate-bounded by the user-store's 5-min cache + in-flight dedupe so
  // this does not hammer the server on every focus.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    if (!isFocused) return;
    const suggestionsEmpty = useForYouStore.getState().suggestions.length === 0;
    if (!suggestionsEmpty && useForYouStore.getState().hasGeneratedTopics) return;
    if (inFlightUserId === userId) return; // another mount is already bootstrapping this user

    inFlightUserId = userId;
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);

    (async () => {
      try {
        // Persona fetch still hydrates onboarding stage / blocked-by-LLM /
        // notification state into the store — only the hasGeneratedTopics
        // source changes below.
        await fetchUserPersonaOrThrow(userId);
        // The device is the authority on topics now: a SUCCESSFUL persona
        // fetch (regardless of what it returns) means we can confidently read
        // the local topics table — an empty table is a confirmed-empty
        // persona, not a failure, and may set false.
        const localTopics = await getActive();
        const hasInterests = localTopics.length > 0;
        if (!cancelled) {
          getForYouActions().setHasGeneratedTopics(hasInterests);
        }
      } catch (error: any) {
        logger.captureException(error, {
          tags: { hook: 'use-feed-bootstrap', method: 'bootstrap' },
          extra: { userId },
        });
        if (!cancelled) {
          // Do NOT touch hasGeneratedTopics here — a transient network/auth
          // failure must not overwrite a healthy persisted flag.
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
  }, [session?.user?.id, isFocused, hasGeneratedTopics]);

  return { isLoading, errorMessage };
}
