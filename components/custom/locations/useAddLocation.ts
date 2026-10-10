import { AccountService } from '@/lib/account-service';
import { getCountryName, getFlagEmoji } from '@/lib/algorithms/country-utils';
import type { LocationRole } from '@/lib/database/models/Location';
import { addUserLocation } from '@/lib/database/services/location-persona-actions';
import { hapticLight } from '@/lib/haptics';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import logger from '@/lib/logger';
import { searchPlaces, type Place } from '@/lib/place-service';
import { toastManager } from '@/lib/toast-manager';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { alpha3ToAlpha2, titleCasePlace, weightForBucket, type WeightBucket } from './location-display';

/** A place resolved either from placeSearch or manual entry, ready to save. */
interface ChosenPlace {
  readonly city: string | null;
  readonly region: string | null;
  /** ISO alpha-2 (matches `locations.countryCode`). */
  readonly countryCode: string;
  readonly label: string;
}

export function useAddLocation({ onSaved }: { onSaved: () => void }) {
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
  const [searchFailed, setSearchFailed] = useState(false);
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
      setSearchFailed(false);
      return;
    }
    const id = ++reqId.current;
    setSearching(true);
    setSearchFailed(false);
    searchPlaces(trimmed)
      .then((result) => {
        if (id !== reqId.current) return; // a newer query superseded this one
        if (result.ok) {
          setResults(result.places);
          setSearchFailed(false);
        } else {
          setResults([]);
          setSearchFailed(true);
        }
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

  return {
    chosen,
    setChosen,
    role,
    setRole,
    bucket,
    setBucket,
    saving,
    query,
    setQuery,
    debouncedQuery,
    results,
    searching,
    searched,
    searchFailed,
    manual,
    setManual,
    manualCity,
    setManualCity,
    manualCountryA3,
    setManualCountryA3,
    countryPickerOpen,
    setCountryPickerOpen,
    countrySearch,
    setCountrySearch,
    countryOptions,
    handlePickPlace,
    handleManualContinue,
    handleSave,
  };
}
