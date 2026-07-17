import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { AccountService } from '@/lib/account-service';
import { getCountryName, getFlagEmoji } from '@/lib/country-utils';
import type { LocationRole } from '@/lib/database/models/Location';
import { addUserLocation } from '@/lib/database/services/location-persona-actions';
import { hapticLight } from '@/lib/haptics';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import logger from '@/lib/logger';
import { searchPlaces, type Place } from '@/lib/place-service';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';
import {
  alpha3ToAlpha2,
  flagForAlpha2,
  titleCasePlace,
  weightForBucket,
  type WeightBucket,
} from './location-display';
import LocationRolePicker from './LocationRolePicker';
import WeightSegments from './WeightSegments';

const ACCENT = '#EDA77E';

/** A place resolved either from placeSearch or manual entry, ready to save. */
interface ChosenPlace {
  readonly city: string | null;
  readonly region: string | null;
  /** ISO alpha-2 (matches `locations.countryCode`). */
  readonly countryCode: string;
  readonly label: string;
}

interface Props {
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

/**
 * Full-screen add-a-place flow. Step 1 = debounced placeSearch type-ahead with a
 * manual fallback (the `places` collection may be unseeded); step 2 = role +
 * weight, then save via the change-logged `addUserLocation`.
 */
const AddLocationView: React.FC<Props> = ({ onClose, onSaved }) => {
  const { t } = useTranslation();

  const [chosen, setChosen] = useState<ChosenPlace | null>(null);
  const [role, setRole] = useState<LocationRole>('home');
  const [bucket, setBucket] = useState<WeightBucket>('medium');
  const [saving, setSaving] = useState(false);

  // ── Step 1 (search) state ─────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const reqId = useRef(0);

  // ── Manual-entry state ────────────────────────────────────────────────────
  const [manual, setManual] = useState(false);
  const [manualCity, setManualCity] = useState('');
  const [countryCodes, setCountryCodes] = useState<string[]>([]); // ISO alpha-3
  const [manualCountryA3, setManualCountryA3] = useState<string | null>(null);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');

  // Run the type-ahead when the debounced query settles.
  useEffect(() => {
    if (manual) return;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    const id = ++reqId.current;
    setSearching(true);
    searchPlaces(trimmed)
      .then((rows) => {
        if (id !== reqId.current) return; // a newer query superseded this one
        setResults(rows);
        setSearched(true);
      })
      .finally(() => {
        if (id === reqId.current) setSearching(false);
      });
  }, [debouncedQuery, manual]);

  // Lazy-load the country list the first time manual entry opens.
  useEffect(() => {
    if (!manual || countryCodes.length > 0) return;
    AccountService.getAllCountries()
      .then((codes) => setCountryCodes(codes.filter((c) => c !== 'GLOBAL')))
      .catch((error) => {
        logger.captureException(error, {
          tags: { component: 'AddLocationView', method: 'getAllCountries' },
        });
      });
  }, [manual, countryCodes.length]);

  const countryOptions = useMemo(() => {
    const q = countrySearch.toLowerCase().trim();
    return countryCodes
      .map((a3) => ({ a3, name: getCountryName(a3), flag: getFlagEmoji(a3) }))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [countryCodes, countrySearch]);

  const handlePickPlace = useCallback((place: Place) => {
    void hapticLight();
    setChosen({
      city: place.city ?? null,
      region: place.region ?? null,
      countryCode: (place.countryCode ?? '').trim().toUpperCase(),
      label: place.displayName,
    });
  }, []);

  const handleManualContinue = useCallback(() => {
    const city = manualCity.trim();
    const a2 = alpha3ToAlpha2(manualCountryA3);
    if (!city || !a2) return;
    void hapticLight();
    setChosen({
      city,
      region: null,
      countryCode: a2,
      label: `${titleCasePlace(city)}, ${a2}`,
    });
  }, [manualCity, manualCountryA3]);

  const handleSave = useCallback(async () => {
    if (!chosen || saving) return;
    setSaving(true);
    try {
      const result = await addUserLocation({
        city: chosen.city,
        region: chosen.region,
        countryCode: chosen.countryCode,
        role,
        weight: weightForBucket(bucket),
      });
      if (result.updated) {
        toastManager.showInfo(t('locations.toastUpdatedTitle'), t('locations.toastUpdatedBody'));
      }
      onSaved();
    } catch (error) {
      logger.captureException(error, {
        tags: { component: 'AddLocationView', method: 'handleSave' },
      });
      toastManager.showError(t('locations.saveFailedTitle'), t('locations.saveFailedBody'));
      setSaving(false);
    }
  }, [chosen, saving, role, bucket, onSaved, t]);

  // ── Configure step ────────────────────────────────────────────────────────
  if (chosen) {
    return (
      <Box className="flex-1 bg-black">
        <DrillDownHeader title={t('locations.addTitle')} onBack={() => setChosen(null)} />
        <VStack className="flex-1 px-5 pt-4" space="lg">
          <HStack className="items-center rounded-xl border border-gray-800 p-3" space="sm">
            <Text className="text-xl">{flagForAlpha2(chosen.countryCode) || '📍'}</Text>
            <Text className="text-white text-base flex-1" numberOfLines={2}>
              {chosen.label}
            </Text>
            <Pressable onPress={() => setChosen(null)} hitSlop={8} accessibilityRole="button">
              <Text className="text-xs" style={{ color: ACCENT }}>
                {t('locations.change')}
              </Text>
            </Pressable>
          </HStack>

          <VStack space="sm">
            <Text className="text-gray-400 text-xs uppercase">{t('locations.roleLabel')}</Text>
            <LocationRolePicker value={role} onChange={setRole} />
          </VStack>

          <VStack space="sm">
            <Text className="text-gray-400 text-xs uppercase">{t('locations.weightLabel')}</Text>
            <WeightSegments value={bucket} onChange={setBucket} />
          </VStack>

          <Button onPress={handleSave} isDisabled={saving} className="mt-2">
            {saving ? <Spinner /> : <ButtonText>{t('locations.saveCta')}</ButtonText>}
          </Button>
        </VStack>
      </Box>
    );
  }

  // ── Manual-entry step ─────────────────────────────────────────────────────
  if (manual) {
    const selectedCountry = manualCountryA3
      ? { name: getCountryName(manualCountryA3), flag: getFlagEmoji(manualCountryA3) }
      : null;
    return (
      <Box className="flex-1 bg-black">
        <DrillDownHeader title={t('locations.addManualTitle')} onBack={() => setManual(false)} />
        <VStack className="flex-1 px-5 pt-4" space="lg">
          <VStack space="xs">
            <Text className="text-gray-400 text-xs uppercase">{t('locations.cityLabel')}</Text>
            <Input variant="outline" size="md" className="border-gray-700">
              <InputSlot className="pl-3">
                <MaterialIcons name="location-city" size={18} color="#999999" />
              </InputSlot>
              <InputField
                placeholder={t('locations.cityPlaceholder')}
                placeholderTextColor="#666666"
                value={manualCity}
                onChangeText={setManualCity}
                className="text-white"
                autoCorrect={false}
              />
            </Input>
          </VStack>

          <VStack space="xs">
            <Text className="text-gray-400 text-xs uppercase">{t('locations.countryLabel')}</Text>
            <Pressable
              onPress={() => setCountryPickerOpen((o) => !o)}
              className="flex-row items-center justify-between rounded-lg border border-gray-700 px-3 py-3"
              accessibilityRole="button"
            >
              <HStack className="items-center" space="sm">
                {selectedCountry ? (
                  <>
                    <Text className="text-xl">{selectedCountry.flag}</Text>
                    <Text className="text-white text-base">{selectedCountry.name}</Text>
                  </>
                ) : (
                  <Text className="text-gray-500 text-base">{t('locations.selectCountry')}</Text>
                )}
              </HStack>
              <MaterialIcons
                name={countryPickerOpen ? 'expand-less' : 'expand-more'}
                size={22}
                color="#999999"
              />
            </Pressable>
          </VStack>

          {countryPickerOpen ? (
            <Box className="flex-1 rounded-lg border border-gray-800">
              <Box className="p-2">
                <Input variant="outline" size="sm" className="border-gray-700">
                  <InputSlot className="pl-3">
                    <MaterialIcons name="search" size={16} color="#999999" />
                  </InputSlot>
                  <InputField
                    placeholder={t('locations.searchCountries')}
                    placeholderTextColor="#666666"
                    value={countrySearch}
                    onChangeText={setCountrySearch}
                    className="text-white"
                    autoCorrect={false}
                  />
                </Input>
              </Box>
              <FlatList
                data={countryOptions}
                keyExtractor={(item) => item.a3}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => {
                      setManualCountryA3(item.a3);
                      setCountryPickerOpen(false);
                      setCountrySearch('');
                    }}
                    className="flex-row items-center px-3 py-3 border-b border-gray-800"
                  >
                    <Text className="text-xl mr-3">{item.flag}</Text>
                    <Text className="text-white text-base">{item.name}</Text>
                  </Pressable>
                )}
              />
            </Box>
          ) : (
            <Button
              onPress={handleManualContinue}
              isDisabled={!manualCity.trim() || !manualCountryA3}
              className="mt-1"
            >
              <ButtonText>{t('common.next')}</ButtonText>
            </Button>
          )}
        </VStack>
      </Box>
    );
  }

  // ── Search step ───────────────────────────────────────────────────────────
  const showNoMatches = searched && !searching && results.length === 0 && debouncedQuery.trim().length >= 2;
  return (
    <Box className="flex-1 bg-black">
      <DrillDownHeader title={t('locations.addTitle')} onBack={onClose} />
      <Box className="px-5 pt-4 pb-2">
        <Input variant="outline" size="md" className="border-gray-700">
          <InputSlot className="pl-3">
            <MaterialIcons name="search" size={18} color="#999999" />
          </InputSlot>
          <InputField
            placeholder={t('locations.searchPlaceholder')}
            placeholderTextColor="#666666"
            value={query}
            onChangeText={setQuery}
            className="text-white"
            autoCorrect={false}
            autoFocus
          />
          {searching ? (
            <InputSlot className="pr-3">
              <Spinner size="small" />
            </InputSlot>
          ) : null}
        </Input>
      </Box>

      <FlatList
        data={results}
        keyExtractor={(item) => item._id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handlePickPlace(item)}
            className="flex-row items-center px-5 py-3 border-b border-gray-800"
          >
            <Text className="text-xl mr-3">{flagForAlpha2(item.countryCode) || '📍'}</Text>
            <Text className="text-white text-base flex-1" numberOfLines={1}>
              {item.displayName}
            </Text>
            <MaterialIcons name="add" size={20} color={ACCENT} />
          </Pressable>
        )}
        ListEmptyComponent={
          showNoMatches ? (
            <VStack className="items-center px-8 py-10" space="sm">
              <MaterialIcons name="search-off" size={40} color="#666666" />
              <Text className="text-gray-400 text-center text-sm">{t('locations.noMatches')}</Text>
            </VStack>
          ) : null
        }
        ListFooterComponent={
          <Pressable
            onPress={() => {
              setManual(true);
              setCountryPickerOpen(false);
            }}
            className="flex-row items-center justify-center px-5 py-4"
            accessibilityRole="button"
          >
            <MaterialIcons name="edit-location-alt" size={18} color={ACCENT} />
            <Text className="ml-2 text-sm" style={{ color: ACCENT }}>
              {t('locations.addManuallyCta')}
            </Text>
          </Pressable>
        }
      />
    </Box>
  );
};

export default AddLocationView;
