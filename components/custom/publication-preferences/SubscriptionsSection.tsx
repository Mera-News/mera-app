import { flagForAlpha2, alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type UserPublicationSubscriptionModel from '@/lib/database/models/UserPublicationSubscription';
import { hapticLight } from '@/lib/haptics';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AddSubscriptionView from './AddSubscriptionView';
import SubscribeConfirmDialog from './SubscribeConfirmDialog';
import { useSubscribeFlow } from './use-subscribe-flow';
import { type ChosenPublisher } from './use-subscriptions';

/**
 * "Your subscriptions": the list, the `+` picker, and the confirm prompt.
 *
 * Renders even when empty, with a short explanation. That is deliberate: the
 * section is how the feature is discovered, and a section that only appears
 * once you already use it can never be found.
 */
const SubscriptionsSection: React.FC = () => {
  const { t } = useTranslation();
  /**
   * The open-page / detect-return / confirm / record machine lives in
   * `use-subscribe-flow` now, shared with the publication-history card and
   * both Sources publisher lists. It owns the `useSubscriptions()`
   * observation too, so this screen must not open a second one.
   */
  const { subscriptions, begin, confirming, onYes, onNo } = useSubscribeFlow();
  const { items, isLoading, busyId, removeSubscription } = subscriptions;

  const [picking, setPicking] = useState(false);

  const handleChoose = useCallback(
    async (chosen: ChosenPublisher) => {
      setPicking(false);
      await begin(chosen);
    },
    [begin],
  );

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
              <Text size="md" className="text-white flex-1">
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
        publisherName={confirming?.publisherName ?? null}
        onYes={onYes}
        onNo={onNo}
      />
    </VStack>
  );
};

export default SubscriptionsSection;
