import { useCallback, useEffect, useRef, useState } from 'react';

import type UserPublicationSubscriptionModel from '@/lib/database/models/UserPublicationSubscription';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import {
  cancelSubscription,
  declinePublisher,
  hasAnsweredForPublisher,
  observeActive,
  refreshSourceNames,
  upsertSubscription,
} from '@/lib/database/services/user-publication-subscription-service';
import logger from '@/lib/logger';
import { resolveSubscriptionSourceNames } from '@/lib/subscriptions/publisher-sources';

/** The shape the picker hands back for a chosen publisher. */
export interface ChosenPublisher {
  readonly publisherId: string;
  readonly publisherName: string;
  readonly countryCode: string;
  readonly subscriptionUri: string | null;
}

/**
 * Owns the subscriptions list and every mutation the screen performs.
 *
 * Deliberately a hook over `observeActive()` rather than a Zustand store:
 * subscriptions have exactly one screen and one article-detail reader, and the
 * WatermelonDB observation already gives both a live list. A store would be a
 * second source of truth for a table that is already reactive.
 */
export function useSubscriptions() {
  const [items, setItems] = useState<UserPublicationSubscriptionModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refreshedRef = useRef(false);

  useEffect(() => {
    const sub = observeActive().subscribe((rows) => {
      setItems(rows);
      setIsLoading(false);
    });
    return () => sub.unsubscribe();
  }, []);

  /**
   * Opportunistic source-name refresh, once per mount.
   *
   * A publisher that gained a feed since the user subscribed starts matching
   * articles without the user doing anything. Failures are silent by design:
   * this is a background improvement, and the stored set keeps working.
   */
  useEffect(() => {
    if (isLoading || refreshedRef.current || items.length === 0) return;
    refreshedRef.current = true;
    void (async () => {
      for (const row of items) {
        try {
          const names = await resolveSubscriptionSourceNames(row.publisherId, row.publisherName);
          if (names.length > 0) await refreshSourceNames(row.publisherId, names);
        } catch {
          // Deliberately swallowed. See the doc comment above.
        }
      }
    })();
  }, [isLoading, items]);

  /**
   * Records a subscription and boosts the publication.
   *
   * The boost goes through `setSourcePrefFromUi`, the single mutation entry
   * point, which owns the guard, the read-before, the change-log entry and the
   * sweep. It writes the canonical boost weight (0.5). DEVIATION FROM THE PLAN,
   * agreed: Part 3 asked for a special 1.0, but `setSourcePrefFromUi` cannot
   * express it, `weightToPrefKind` classifies both as the same 'boost' kind,
   * and the existing 3-way selector on this very screen can only ever write
   * 0.5 — so a 1.0 would be silently flattened the first time anyone touched
   * the row. Writing the row directly to get 1.0 would bypass the dance the
   * plan explicitly says not to bypass.
   */
  const addSubscription = useCallback(async (chosen: ChosenPublisher) => {
    setBusyId(chosen.publisherId);
    try {
      const sourceNames = await resolveSubscriptionSourceNames(
        chosen.publisherId,
        chosen.publisherName,
      );
      await upsertSubscription({
        publisherId: chosen.publisherId,
        publisherName: chosen.publisherName,
        countryCode: chosen.countryCode,
        subscriptionUri: chosen.subscriptionUri,
        sourceNames,
      });
      await setSourcePrefFromUi(
        { kind: 'publication', publicationName: chosen.publisherName },
        'prioritised',
      );
      return true;
    } catch (error) {
      logger.captureException(error, {
        tags: { service: 'use-subscriptions', method: 'addSubscription' },
        extra: { publisherId: chosen.publisherId },
      });
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  /**
   * Retires the subscription row and LEAVES THE BOOST ALONE.
   *
   * The user may still want the source prioritised, and there is no special
   * weight to unwind (see `addSubscription`). Un-boosting here would silently
   * undo a preference the user can see and set independently on this screen.
   */
  const removeSubscription = useCallback(
    async (row: UserPublicationSubscriptionModel) => {
      setBusyId(row.id);
      try {
        await cancelSubscription(row.id);
        return true;
      } catch (error) {
        logger.captureException(error, {
          tags: { service: 'use-subscriptions', method: 'removeSubscription' },
          extra: { subscriptionId: row.id },
        });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  /** A No to the prompt. Persisted so it never fires for this publisher again. */
  const declineSubscription = useCallback(async (chosen: ChosenPublisher) => {
    try {
      await declinePublisher({
        publisherId: chosen.publisherId,
        publisherName: chosen.publisherName,
        countryCode: chosen.countryCode,
        subscriptionUri: chosen.subscriptionUri,
      });
    } catch (error) {
      logger.captureException(error, {
        tags: { service: 'use-subscriptions', method: 'declineSubscription' },
        extra: { publisherId: chosen.publisherId },
      });
    }
  }, []);

  return {
    items,
    isLoading,
    busyId,
    addSubscription,
    removeSubscription,
    declineSubscription,
    hasAnsweredForPublisher,
  };
}
