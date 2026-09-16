import { hapticLight } from '@/lib/haptics';
import { onReturnFromBackground, openSubscribePage } from '@/lib/subscriptions/subscribe-flow';
import { toastManager } from '@/lib/toast-manager';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSubscriptions, type ChosenPublisher } from './use-subscriptions';

/**
 * The whole "send them to the publisher, ask when they come back" machine,
 * extracted so the three surfaces that offer it share ONE copy.
 *
 * It was private to `SubscriptionsSection` while the settings screen was the
 * only place a subscribe link existed. It is now offered from the publication
 * history card and from both Sources publisher lists as well, and three
 * hand-rolled copies of open-page / detect-return / confirm / record is the
 * single biggest way this feature rots: the `background` versus `inactive`
 * distinction, the already-answered re-check, and the bad-URI fallback are
 * each one line and each silently wrong if a copy forgets them.
 *
 * It owns the `useSubscriptions()` subscription too, and re-exposes it, so a
 * caller never opens a second WatermelonDB observation for the same table.
 */
export function useSubscribeFlow() {
  const { t } = useTranslation();
  const subscriptions = useSubscriptions();
  const { addSubscription, declineSubscription, hasAnsweredForPublisher } = subscriptions;

  const [confirming, setConfirming] = useState<ChosenPublisher | null>(null);
  /** Who we sent to a subscribe page and are waiting to ask about on return. */
  const awaitingReturnRef = useRef<ChosenPublisher | null>(null);

  /**
   * The prompt is armed by a background -> active transition, not by the
   * browser's own result: `expo-web-browser` resolves `{type:'opened'}`
   * immediately on Android and its cancel/dismiss types are iOS-only, so
   * there is no cross-platform close signal. See `subscribe-flow.ts` for why
   * it listens for `background` specifically and not `!== 'active'`.
   */
  useEffect(() => {
    const unsubscribe = onReturnFromBackground(() => {
      const pending = awaitingReturnRef.current;
      if (!pending) return;
      awaitingReturnRef.current = null;
      void (async () => {
        // Between opening the page and coming back, the user may have added
        // this publisher another way, or declined it. Asking again would be
        // asking a question already answered.
        if (await hasAnsweredForPublisher(pending.publisherId)) return;
        setConfirming(pending);
      })();
    });
    return unsubscribe;
  }, [hasAnsweredForPublisher]);

  /**
   * Start the flow for one publisher.
   *
   * Both fallbacks land on the same confirm dialog rather than a dead end:
   * a publisher with no subscribe page has nothing to come back FROM, and a
   * bad URI is a catalogue fault rather than the user's problem. In both
   * cases the question we actually want answered ("do you pay for this?") is
   * still worth asking directly.
   */
  const begin = useCallback(async (chosen: ChosenPublisher) => {
    void hapticLight();

    if (!chosen.subscriptionUri) {
      setConfirming(chosen);
      return;
    }

    const opened = await openSubscribePage(chosen.subscriptionUri);
    if (!opened) {
      setConfirming(chosen);
      return;
    }
    awaitingReturnRef.current = chosen;
  }, []);

  /**
   * Record a subscription WITHOUT the browser trip.
   *
   * The "I subscribe to this" path: the reader is telling us something they
   * already know, so sending them to a pricing page first would be absurd.
   * Same durable write as answering Yes to the dialog.
   */
  const confirmDirectly = useCallback(
    async (chosen: ChosenPublisher) => {
      void hapticLight();
      const ok = await addSubscription(chosen);
      if (ok) {
        toastManager.showInfo(t('subscriptions.added', { publisher: chosen.publisherName }));
      }
      return ok;
    },
    [addSubscription, t],
  );

  const onYes = useCallback(async () => {
    const chosen = confirming;
    setConfirming(null);
    if (!chosen) return;
    const ok = await addSubscription(chosen);
    if (ok) {
      toastManager.showInfo(t('subscriptions.added', { publisher: chosen.publisherName }));
    }
  }, [confirming, addSubscription, t]);

  const onNo = useCallback(async () => {
    const chosen = confirming;
    setConfirming(null);
    if (chosen) await declineSubscription(chosen);
  }, [confirming, declineSubscription]);

  /**
   * A swipe-down or a hardware back. Closes and writes NOTHING.
   *
   * Deliberately not `onNo`. Declining is durable and permanent: it silences
   * the prompt for that publisher for good. Dismissing a dialog is not an
   * answer to the question it asked, and inferring one from it means a reader
   * who swiped a sheet away can never be asked again. The re-prompt this is
   * often feared to cause does not happen either: the prompt is only ever
   * raised on a return from a subscribe page, behind a
   * `hasAnsweredForPublisher` check.
   */
  const onDismiss = useCallback(() => {
    setConfirming(null);
  }, []);

  /**
   * Whether an ACTIVE subscription row already exists for this publisher.
   *
   * Drives hiding the affordance entirely rather than greying it: a reader
   * who has already told us they pay for this has no question left to answer
   * here, and the settings screen is where a subscription is managed.
   */
  const isSubscribed = useCallback(
    (publisherId: string) => subscriptions.items.some((row) => row.publisherId === publisherId),
    [subscriptions.items],
  );

  return {
    subscriptions,
    begin,
    confirmDirectly,
    confirming,
    onYes,
    onNo,
    onDismiss,
    isSubscribed,
  };
}
