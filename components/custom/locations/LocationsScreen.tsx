import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type LocationModel from '@/lib/database/models/Location';
import {
  observeAll as observeAllLocations,
  setPinnedForWeather,
} from '@/lib/database/services/location-service';
import {
  deleteUserLocation,
  setLocationWeightLogged,
} from '@/lib/database/services/location-persona-actions';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';
import AddLocationView from './AddLocationView';
import WeightSegments from './WeightSegments';
import {
  composeLocationLabel,
  flagForAlpha2,
  nearestBucket,
  roleMeta,
  weightForBucket,
  type WeightBucket,
} from './location-display';

const ACCENT = '#EDA77E';

interface Props {
  readonly onBack: () => void;
}

/** Locale-formatted "until" date for a travel row's validUntil (ms epoch). */
function formatValidUntil(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

const LocationsScreen: React.FC<Props> = ({ onBack }) => {
  const { t } = useTranslation();
  const [locations, setLocations] = useState<LocationModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LocationModel | null>(null);

  // Reactive, weight-desc. Add/delete/weight edits all flow back through here.
  useEffect(() => {
    const sub = observeAllLocations().subscribe((rows) => {
      setLocations(rows);
      setIsLoading(false);
    });
    return () => sub.unsubscribe();
  }, []);

  const handleWeightChange = useCallback(
    async (loc: LocationModel, next: WeightBucket) => {
      const nextWeight = weightForBucket(next);
      if (Math.abs(nextWeight - loc.weight) < 1e-6) return; // already there — no log row
      void hapticLight();
      try {
        await setLocationWeightLogged(loc.id, nextWeight);
      } catch (error) {
        logger.captureException(error, {
          tags: { component: 'LocationsScreen', method: 'handleWeightChange' },
        });
      }
    },
    [],
  );

  const handlePin = useCallback(async (loc: LocationModel) => {
    if (loc.pinnedForWeather) return; // single-pin radio: re-tapping the pin is a no-op
    void hapticLight();
    try {
      await setPinnedForWeather(loc.id);
    } catch (error) {
      logger.captureException(error, {
        tags: { component: 'LocationsScreen', method: 'handlePin' },
      });
    }
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    const loc = confirmDelete;
    if (!loc) return;
    setConfirmDelete(null);
    void hapticLight();
    try {
      await deleteUserLocation({
        id: loc.id,
        city: loc.city,
        countryCode: loc.countryCode,
        role: loc.role,
      });
    } catch (error) {
      logger.captureException(error, {
        tags: { component: 'LocationsScreen', method: 'handleDeleteConfirm' },
      });
      toastManager.showError(t('locations.deleteFailedTitle'), t('locations.deleteFailedBody'));
    }
  }, [confirmDelete, t]);

  const renderItem = useCallback(
    ({ item }: { item: LocationModel }) => {
      const meta = roleMeta(item.role);
      const bucket = nearestBucket(item.weight);
      const flag = flagForAlpha2(item.countryCode);
      const showValidUntil = item.role === 'travel' && item.validUntil != null;
      return (
        <View className="px-5 py-3 border-b border-gray-800">
          <HStack className="items-center" space="sm">
            <MaterialIcons name={meta.icon} size={22} color={ACCENT} />
            {flag ? <Text className="text-xl">{flag}</Text> : null}
            <Text className="text-white text-base flex-1" numberOfLines={1}>
              {composeLocationLabel(item)}
            </Text>
            <Pressable
              onPress={() => handlePin(item)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('locations.pinForWeather')}
              accessibilityState={{ selected: item.pinnedForWeather }}
              className="p-1"
            >
              <MaterialIcons
                name={item.pinnedForWeather ? 'star' : 'star-outline'}
                size={22}
                color={item.pinnedForWeather ? ACCENT : '#666666'}
              />
            </Pressable>
            <Pressable
              onPress={() => setConfirmDelete(item)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.delete')}
              className="p-1"
            >
              <MaterialIcons name="delete-outline" size={22} color="#999999" />
            </Pressable>
          </HStack>

          <HStack className="items-center mt-2 ml-8" space="xs">
            <View className="flex-row items-center border border-gray-700 rounded-full px-2 py-0.5">
              <Text className="text-xs text-gray-300">
                {t(`locations.roles.${meta.labelKey}` as never)}
              </Text>
            </View>
            {showValidUntil ? (
              <View className="flex-row items-center bg-gray-800 rounded-full px-2 py-0.5">
                <MaterialIcons name="event" size={12} color="#999999" />
                <Text className="text-xs text-gray-300 ml-1">
                  {t('locations.until', { date: formatValidUntil(item.validUntil as number) })}
                </Text>
              </View>
            ) : null}
            {item.pinnedForWeather ? (
              <View className="flex-row items-center bg-gray-800 rounded-full px-2 py-0.5">
                <MaterialIcons name="wb-sunny" size={12} color={ACCENT} />
                <Text className="text-xs text-gray-300 ml-1">{t('locations.pinnedBadge')}</Text>
              </View>
            ) : null}
          </HStack>

          <Box className="mt-2 ml-8">
            <WeightSegments value={bucket} onChange={(b) => handleWeightChange(item, b)} compact />
          </Box>
        </View>
      );
    },
    [handlePin, handleWeightChange, t],
  );

  if (adding) {
    return <AddLocationView onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />;
  }

  return (
    <Box className="flex-1 bg-black">
      <DrillDownHeader
        title={t('locations.title')}
        subtitle={t('locations.subtitle')}
        onBack={onBack}
        rightAction={
          <Pressable
            onPress={() => setAdding(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('locations.add')}
            className="p-2 rounded-full border border-primary-500"
          >
            <MaterialIcons name="add" size={20} color={ACCENT} />
          </Pressable>
        }
      />

      {isLoading ? (
        <Box className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </Box>
      ) : locations.length === 0 ? (
        <VStack className="flex-1 items-center justify-center px-8" space="md">
          <MaterialIcons name="add-location-alt" size={56} color="#666666" />
          <Text size="md" className="text-gray-400 text-center">
            {t('locations.empty')}
          </Text>
          <Button
            variant="outline"
            className="rounded-full border-primary-500 mt-1"
            onPress={() => setAdding(true)}
          >
            <ButtonText className="text-primary-400">{t('locations.addFirst')}</ButtonText>
          </Button>
        </VStack>
      ) : (
        <FlatList
          data={locations}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        />
      )}

      <Modal isOpen={confirmDelete !== null} onClose={() => setConfirmDelete(null)} size="sm">
        <ModalBackdrop />
        <ModalContent>
          <ModalHeader className="pb-3">
            <HStack className="items-center" space="xs">
              <MaterialIcons name="wrong-location" size={18} color={ACCENT} />
              <Text className="text-base font-semibold text-white">
                {t('locations.deleteConfirmTitle')}
              </Text>
            </HStack>
          </ModalHeader>
          <ModalBody className="py-4">
            <Text className="text-gray-300 text-sm leading-relaxed">
              {t('locations.deleteConfirmBody')}
            </Text>
            {confirmDelete ? (
              <Text className="text-white font-medium mt-2">
                {composeLocationLabel(confirmDelete)}
              </Text>
            ) : null}
          </ModalBody>
          <ModalFooter className="border-t border-gray-700 pt-4">
            <VStack className="w-full" space="md">
              <Button action="negative" onPress={handleDeleteConfirm} className="w-full">
                <ButtonText>{t('common.delete')}</ButtonText>
              </Button>
              <Button
                variant="outline"
                action="secondary"
                onPress={() => setConfirmDelete(null)}
                className="w-full"
              >
                <ButtonText>{t('common.cancel')}</ButtonText>
              </Button>
            </VStack>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
};

export default LocationsScreen;
