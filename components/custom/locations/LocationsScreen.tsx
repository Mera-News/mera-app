import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { Group, Help } from '@/components/custom/you/rows';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type LocationModel from '@/lib/database/models/Location';
import type { LocationRole } from '@/lib/database/models/Location';
import {
  observeAll as observeAllLocations,
  setPinnedForWeather,
  setRole,
} from '@/lib/database/services/location-service';
import {
  deleteUserLocation,
  setLocationWeightLogged,
} from '@/lib/database/services/location-persona-actions';
import { showDialog } from '@/lib/dialog';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useColors } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import AddLocationView from './AddLocationView';
import LocationRolePicker from './LocationRolePicker';
import WeightSegments from './WeightSegments';
import {
  composeLocationLabel,
  nearestBucket,
  roleMeta,
  weightForBucket,
  type WeightBucket,
} from './location-display';
import { useTabContentBottomInset } from '@/lib/navigation/tab-bar';

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

/**
 * Profile > Places (FinalProfile #11): one line of explanation, then each
 * place with its role and how much local news it brings; Relabel, Use for
 * weather and Remove live in its ••• menu. "+" adds a place.
 */
const LocationsScreen: React.FC<Props> = ({ onBack }) => {
  const bottomInset = useTabContentBottomInset();
  const { t } = useTranslation();
  const colors = useColors();
  const [locations, setLocations] = useState<LocationModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<LocationModel | null>(null);
  const [relabeling, setRelabeling] = useState(false);
  const pendingRemove = useRef<LocationModel | null>(null);

  // Reactive, weight-desc. Add/delete/weight edits all flow back through here.
  useEffect(() => {
    const sub = observeAllLocations().subscribe((rows) => {
      setLocations(rows);
      setIsLoading(false);
    });
    return () => sub.unsubscribe();
  }, []);

  const handleWeightChange = useCallback(async (loc: LocationModel, next: WeightBucket) => {
    const nextWeight = weightForBucket(next);
    if (Math.abs(nextWeight - loc.weight) < 1e-6) return; // already there: no log row
    void hapticLight();
    try {
      await setLocationWeightLogged(loc.id, nextWeight);
    } catch (error) {
      logger.captureException(error, { tags: { component: 'LocationsScreen', method: 'handleWeightChange' } });
    }
  }, []);

  const closeMenu = useCallback(() => {
    setMenuFor(null);
    setRelabeling(false);
  }, []);

  const relabel = useCallback(
    async (loc: LocationModel, role: LocationRole) => {
      closeMenu();
      try {
        await setRole(loc.id, role);
      } catch (error) {
        logger.captureException(error, { tags: { component: 'LocationsScreen', method: 'relabel' } });
      }
    },
    [closeMenu],
  );

  const pinForWeather = useCallback(
    async (loc: LocationModel) => {
      closeMenu();
      if (loc.pinnedForWeather) return; // single pin: re-picking is a no-op
      void hapticLight();
      try {
        await setPinnedForWeather(loc.id);
      } catch (error) {
        logger.captureException(error, { tags: { component: 'LocationsScreen', method: 'pinForWeather' } });
      }
    },
    [closeMenu],
  );

  // The confirm shows once the sheet is fully gone (a dialog never stacks on it).
  const onMenuClosed = useCallback(async () => {
    const loc = pendingRemove.current;
    pendingRemove.current = null;
    if (!loc) return;
    const ok = await showDialog({
      title: t('locations.deleteConfirmTitle'),
      body: `${t('locations.deleteConfirmBody')}\n\n${composeLocationLabel(loc)}`,
      confirmLabel: t('locations.remove'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    void hapticLight();
    try {
      await deleteUserLocation({ id: loc.id, city: loc.city, countryCode: loc.countryCode, role: loc.role });
    } catch (error) {
      logger.captureException(error, { tags: { component: 'LocationsScreen', method: 'remove' } });
      toastManager.showError(t('locations.deleteFailedTitle'), t('locations.deleteFailedBody'));
    }
  }, [t]);

  const renderPlace = (loc: LocationModel) => {
    const meta = roleMeta(loc.role);
    const label = composeLocationLabel(loc);
    const role = t(`locations.roles.${meta.labelKey}`);
    const sub =
      loc.role === 'travel' && loc.validUntil != null
        ? `${role} · ${t('locations.until', { date: formatValidUntil(loc.validUntil) })}`
        : role;
    return (
      <View key={loc.id} testID={`place-${loc.id}`} style={{ paddingVertical: 12, paddingLeft: 16, paddingRight: 4, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16, lineHeight: 21 }}>
              {label}
            </Text>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{sub}</Text>
          </View>
          <Pressable
            testID={`place-menu-${loc.id}`}
            onPress={() => setMenuFor(loc)}
            accessibilityRole="button"
            accessibilityLabel={t('locations.menuA11y', { place: label })}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <MaterialIcons name="more-horiz" size={22} color={colors.ink2} />
          </Pressable>
        </View>
        <View style={{ paddingRight: 12 }}>
          <WeightSegments value={nearestBucket(loc.weight)} onChange={(b) => handleWeightChange(loc, b)} compact />
        </View>
      </View>
    );
  };

  const renderSavedList = useCallback(() => {
    if (isLoading) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size="large" />
        </View>
      );
    }
    if (locations.length === 0) {
      return (
        <VStack className="flex-1 items-center justify-center px-8" space="md">
          <MaterialIcons name="add-location-alt" size={56} color={colors.ink3} />
          <Text size="md" className="text-center" style={{ color: colors.ink2 }}>
            {t('locations.empty')}
          </Text>
          <Button variant="outline" className="rounded-full border-primary-500 mt-1" onPress={() => setSearchOpen(true)}>
            <ButtonText className="text-primary-400">{t('locations.addFirst')}</ButtonText>
          </Button>
        </VStack>
      );
    }
    return (
      <ScrollView
        testID="places-list"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: SUBPAGE_TOP_GAP, paddingBottom: bottomInset, gap: 12 }}
      >
        <Help>{t('locations.intro')}</Help>
        <Group>{locations.map(renderPlace)}</Group>
        <Help>{t('locations.footnote')}</Help>
      </ScrollView>
    );
    // renderPlace reads only state already in these deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, locations, colors, t]);

  return (
    <View style={{ flex: 1 }}>
      <DrillDownHeader
        title={t('locations.title')}
        onBack={onBack}
        rightAction={
          <Pressable
            testID="places-add"
            onPress={() => setSearchOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel={searchOpen ? t('common.cancel') : t('locations.add')}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <MaterialIcons name={searchOpen ? 'close' : 'add'} size={24} color={colors.ink} />
          </Pressable>
        }
      />

      {searchOpen ? (
        <AddLocationView
          onClose={() => setSearchOpen(false)}
          onSaved={() => setSearchOpen(false)}
          renderIdle={renderSavedList}
        />
      ) : (
        renderSavedList()
      )}

      <BottomSheet testID="place-menu-sheet" open={menuFor !== null} onClose={closeMenu} onClosed={onMenuClosed}>
        {menuFor && relabeling ? (
          <View style={{ gap: 12 }}>
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('locations.roleLabel')}</Text>
            <LocationRolePicker value={menuFor.role} onChange={(role) => relabel(menuFor, role)} />
          </View>
        ) : menuFor ? (
          <Group>
            <MenuRow testID="place-menu-relabel" icon="label-outline" label={t('locations.relabel')} onPress={() => setRelabeling(true)} />
            <MenuRow
              testID="place-menu-weather"
              icon="wb-sunny"
              label={t('locations.useForWeather')}
              checked={menuFor.pinnedForWeather}
              onPress={() => pinForWeather(menuFor)}
            />
            <MenuRow
              testID="place-menu-remove"
              icon="delete-outline"
              label={t('locations.remove')}
              destructive
              onPress={() => {
                pendingRemove.current = menuFor;
                closeMenu();
              }}
            />
          </Group>
        ) : null}
      </BottomSheet>
    </View>
  );
};

const MenuRow: React.FC<{
  readonly icon: keyof typeof MaterialIcons.glyphMap;
  readonly label: string;
  readonly onPress: () => void;
  readonly checked?: boolean;
  readonly destructive?: boolean;
  readonly testID: string;
}> = ({ icon, label, onPress, checked = false, destructive = false, testID }) => {
  const colors = useColors();
  const ink = destructive ? colors.negative : colors.ink;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 16 }}
    >
      <MaterialIcons name={icon} size={20} color={ink} />
      <Text style={{ flex: 1, color: ink, fontSize: 16 }}>{label}</Text>
      {checked ? <MaterialIcons name="check" size={20} color={colors.accent} /> : null}
    </Pressable>
  );
};

export default LocationsScreen;
