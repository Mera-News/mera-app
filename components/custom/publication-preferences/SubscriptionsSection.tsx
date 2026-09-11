import { flagForAlpha2, alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type UserPublicationSubscriptionModel from '@/lib/database/models/UserPublicationSubscription';
import { hapticLight } from '@/lib/haptics';
import { openSubscribePage, onReturnFromBackground } from '@/lib/subscriptions/subscribe-flow';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AddSubscriptionView from './AddSubscriptionView';
import SubscribeConfirmDialog from './SubscribeConfirmDialog';
import { useSubscriptions, type ChosenPublisher } from './use-subscriptions';

/**
 * "Your subscriptions": the list, the `+` picker, and the confirm prompt.
 *
 * Renders even when empty, with a short explanation. That is deliberate: the
 * section is how the feature is discovered, and a section that only appears
 * once you already use it can never be found.
 */
const SubscriptionsSection: React.FC = () => {
  const { t } = useTranslation();
  const {
    items,
    isLoading,
    busyId,
    addSubscription,
    removeSubscription,
    declineSubscription,
    hasAnsweredForPublisher,
  } = useSubscriptions();

  const [picking, setPicking] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<ChosenPublisher | null>(null);
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
        setPendingConfirm(pending);
      })();
    });
    return unsubscribe;
  }, [hasAnsweredForPublisher]);

  const handleChoose = useCallback(
    async (chosen: ChosenPublisher) => {
      setPicking(false);
      void hapticLight();

      // No subscribe page to send them to, so there is nothing to come back
      // from: ask directly rather than showing a dead "Subscribe" affordance.
      if (!chosen.subscriptionUri) {
        setPendingConfirm(chosen);
        return;
      }

      const opened = await openSubscribePage(chosen.subscriptionUri);
      if (!opened) {
        // A bad URI is a catalogue fault, not the user's problem. Fall back to
        // asking directly so the flow still completes.
        setPendingConfirm(chosen);
        return;
      }
      awaitingReturnRef.current = chosen;
    },
    [],
  );

  const handleYes = useCallback(async () => {
    const chosen = pendingConfirm;
    setPendingConfirm(null);
    if (!chosen) return;
    const ok = await addSubscription(chosen);
    if (ok) {
      toastManager.showInfo(t('subscriptions.added', { publisher: chosen.publisherName }));
    }
  }, [pendingConfirm, addSubscription, t]);

  const handleNo = useCallback(async () => {
    const chosen = pendingConfirm;
    setPendingConfirm(null);
    if (chosen) await declineSubscription(chosen);
  }, [pendingConfirm, declineSubscription]);

  const handleRemove = useCallback(
    async (row: UserPublicationSubscriptionModel) => {
      void hapticLight();
      const ok = await removeSubscription(row);
      if (ok) {
        toastManager.showInfo(t('subscriptions.removed', { publisher: row.publisherName }));
      }
    },
    [removeSubscription, t],
  );

  return (
    <VStack space="xs" className="pt-2">
      <HStack className="items-center justify-between px-4 pb-1">
        <Text size="sm" className="text-gray-400 uppercase">
          {t('subscriptions.sectionTitle')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            picking ? t('subscriptions.close') : t('subscriptions.add')
          }
          accessibilityState={{ expanded: picking }}
          onPress={() => {
            void hapticLight();
            setPicking((p) => !p);
          }}
          className="p-2"
        >
          <MaterialIcons name={picking ? 'close' : 'add'} size={22} color="#ffffff" />
        </Pressable>
      </HStack>

      {picking && <AddSubscriptionView onChoose={handleChoose} disabled={busyId != null} />}

      {isLoading ? (
        <Box className="px-4 py-3">
          <Spinner size="small" />
        </Box>
      ) : items.length === 0 ? (
        <Text size="sm" className="text-gray-400 px-4 pb-2">
          {t('subscriptions.empty')}
        </Text>
      ) : (
        items.map((row) => (
          <HStack key={row.id} className="items-center justify-between px-4 py-3">
            <HStack space="sm" className="items-center flex-1">
              <Text size="md">{flagForAlpha2(alpha3ToAlpha2(row.countryCode))}</Text>
              <Text size="md" className="text-typography-0 flex-1">
                {row.publisherName}
              </Text>
            </HStack>
            <Pressable
              accessibilityRole="button"
              // Names the publisher, so a screen reader user knows WHICH row
              // they are about to remove.
              accessibilityLabel={t('subscriptions.removeA11y', {
                publisher: row.publisherName,
              })}
              disabled={busyId === row.id}
              onPress={() => handleRemove(row)}
              className="px-2 py-1"
            >
              <Text size="sm" className="text-gray-300">
                {t('subscriptions.remove')}
              </Text>
            </Pressable>
          </HStack>
        ))
      )}

      <SubscribeConfirmDialog
        publisherName={pendingConfirm?.publisherName ?? null}
        onYes={handleYes}
        onNo={handleNo}
      />
    </VStack>
  );
};

export default SubscriptionsSection;
