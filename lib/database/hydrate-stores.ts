// Hydrates all Zustand stores from WatermelonDB on app startup.
//
// Fire-and-forget. The For You suggestion query goes first so it absorbs the
// WatermelonDB open + migration cost rather than queueing behind 5 unrelated
// stores — the For You screen subscribes to the store and re-renders the
// instant the suggestions set() lands. Everything else hydrates in parallel
// in the background; database-store.ready flips once all of it has finished,
// which is the gate for syncFeed.

import { pruneStaleVisits } from './services/publication-visit-service';
import { useDatabaseStore } from '../stores/database-store';
import { reconcileAppLanguageWithPersona } from '../language-sync';
import logger from '../logger';

export function hydrateAllStores(): Promise<void> {
  // Dynamic imports to avoid circular dependencies
  const { useForYouStore } = require('../stores/for-you-store');
  const { useUserStore } = require('../stores/user-store');
  const { useMeraProtocolStore } = require('../stores/mera-protocol-store');
  const { useOnboardingStore } = require('../stores/onboarding-store');
  const { useAppLanguageStore } = require('../stores/app-language-store');
  const { useAppStateStore } = require('../stores/app-state-store');
  const { useForYouPrefsStore } = require('../stores/for-you-prefs-store');

  // Paint-critical: load cached article_suggestions and push them to the
  // store first. No metadata, no expired-cleanup, no other-store gating.
  // Not awaited (first-paint design). Defense-in-depth catch so any leak
  // past the store's internal try/catch still reaches Sentry.
  useForYouStore
    .getState()
    .hydrateSuggestionsFromDb()
    .catch((err: unknown) => {
      logger.captureException(err, {
        tags: { module: 'hydrate-stores', step: 'paint-critical-hydrate' },
      });
    });

  // Everything else, in parallel, in the background. Returned promise
  // resolves once full hydration + backfill is done — callers who need
  // hydrated state (e.g. processingMode, userPersona) can chain on this,
  // but no caller should block first paint on it.
  return Promise.all([
    useForYouStore.getState().hydrateMetadataFromDb(),
    useUserStore.getState().hydrateFromDb(),
    useMeraProtocolStore.getState().hydrateFromDb(),
    useOnboardingStore.getState().hydrateFromDb(),
    useAppLanguageStore.getState().hydrateFromDb(),
    useAppStateStore.getState().hydrateFromDb(),
    useForYouPrefsStore.getState().hydrate(),
  ])
    .then(() => {
      // Fire-and-forget: back-fill the persona's primary language_codes from the
      // (now-hydrated) app UI language for users who picked a language before the
      // sync existed. Deliberately NOT awaited — it must never gate
      // database-store.ready or first-paint.
      reconcileAppLanguageWithPersona().catch((err: unknown) => {
        logger.captureException(err, {
          tags: { module: 'hydrate-stores', step: 'reconcile-app-language' },
        });
      });

      return pruneStaleVisits().catch((err: unknown) => {
        logger.captureException(err, {
          tags: { module: 'hydrate-stores', step: 'prune-stale-visits' },
        });
      });
    })
    .finally(() => useDatabaseStore.getState().setReady(true))
    .then(() => undefined);
}
