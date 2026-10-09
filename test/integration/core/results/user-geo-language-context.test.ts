// user-geo-language-context: the loader (and the hook's refresh logic) that builds the ranking
// context from on-device state. Locations, publication preferences and subscriptions are seeded
// through their own services on the in-memory DB; the language comes from the real app-language store.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { getLocales } from 'expo-localization';
import * as locationService from '@/lib/database/services/location-service';
import { upsertLocation } from '@/lib/database/services/location-service';
import {
  retirePreference,
  upsertPreference,
  upsertScopePreference,
} from '@/lib/database/services/publication-preference-service';
import { upsertSubscription } from '@/lib/database/services/user-publication-subscription-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
  loadUserGeoLanguageContext,
  useUserGeoLanguageContext,
} from '@/lib/user-context/user-geo-language-context';

const DEFAULT_LOCALES = [{ languageCode: 'en', regionCode: 'US', languageTag: 'en-US' }];

function setDeviceRegion(regionCode: string | null) {
  jest.mocked(getLocales).mockReturnValue([{ ...DEFAULT_LOCALES[0], regionCode }] as never);
}

beforeEach(() => {
  useAppLanguageStore.setState({ appLanguage: 'en' });
});

afterEach(() => {
  jest.mocked(getLocales).mockReturnValue(DEFAULT_LOCALES as never);
  useAppLanguageStore.setState({ appLanguage: 'en' });
  jest.restoreAllMocks();
});

describe('loadUserGeoLanguageContext: countries and language', () => {
  it('with nothing stored it falls back to the device country and has no source-preference keys', async () => {
    const ctx = await loadUserGeoLanguageContext();

    // toStrictEqual: a user with no source preference gets the exact pre-source-pref shape.
    expect(ctx).toStrictEqual({ homeCountryAlpha3: 'USA', otherCountriesAlpha3: [], appLanguageBase: 'en' });
  });

  it('takes home from the home location and orders the others by weight, deduped, without home', async () => {
    await upsertLocation({ city: 'Mumbai', countryCode: 'IN', role: 'home', weight: 1 });
    await upsertLocation({ city: 'Pune', countryCode: 'IN', role: 'work', weight: 0.9 });
    await upsertLocation({ city: 'Berlin', countryCode: 'DE', role: 'work', weight: 0.8 });
    await upsertLocation({ city: 'Hamburg', countryCode: 'DE', role: 'travel', weight: 0.7 });
    await upsertLocation({ city: 'Paris', countryCode: 'FR', role: 'travel', weight: 0.6 });

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx).toMatchObject({ homeCountryAlpha3: 'IND', otherCountriesAlpha3: ['DEU', 'FRA'] });
  });

  it('drops a location whose country cannot be converted', async () => {
    await upsertLocation({ city: 'Mumbai', countryCode: 'IN', role: 'home', weight: 1 });
    await upsertLocation({ city: 'Nowhere', countryCode: 'ZZ', role: 'travel', weight: 0.9 });
    await upsertLocation({ city: 'Berlin', countryCode: 'DE', role: 'travel', weight: 0.5 });

    expect(await loadUserGeoLanguageContext()).toMatchObject({ otherCountriesAlpha3: ['DEU'] });
  });

  it('with no home row, home is the device country and the others exclude it', async () => {
    setDeviceRegion('de');
    await upsertLocation({ city: 'Berlin', countryCode: 'DE', role: 'work', weight: 0.9 });
    await upsertLocation({ city: 'Paris', countryCode: 'FR', role: 'travel', weight: 0.5 });

    expect(await loadUserGeoLanguageContext()).toMatchObject({
      homeCountryAlpha3: 'DEU',
      otherCountriesAlpha3: ['FRA'],
    });
  });

  it('a home row whose code is unmappable falls back to the device country', async () => {
    setDeviceRegion('JP');
    await upsertLocation({ city: 'Nowhere', countryCode: 'ZZ', role: 'home', weight: 1 });

    expect(await loadUserGeoLanguageContext()).toMatchObject({ homeCountryAlpha3: 'JPN', otherCountriesAlpha3: [] });
  });

  it('home is null when neither the home row nor the device country maps', async () => {
    setDeviceRegion('ZZ');

    expect(await loadUserGeoLanguageContext()).toMatchObject({ homeCountryAlpha3: null, otherCountriesAlpha3: [] });
  });

  it('the language is the base tag of the app language', async () => {
    useAppLanguageStore.setState({ appLanguage: 'zh-Hans' });
    expect(await loadUserGeoLanguageContext()).toMatchObject({ appLanguageBase: 'zh' });

    useAppLanguageStore.setState({ appLanguage: 'pt' });
    expect(await loadUserGeoLanguageContext()).toMatchObject({ appLanguageBase: 'pt' });
  });

  it('fails open to null when a read throws', async () => {
    jest.spyOn(locationService, 'getAll').mockRejectedValueOnce(new Error('db gone'));

    expect(await loadUserGeoLanguageContext()).toBeNull();
  });
});

describe('loadUserGeoLanguageContext: source preferences', () => {
  it('turns More, Fewer and Mute into preferred names and ranking multipliers', async () => {
    await upsertPreference({ publicationName: 'The Hindu', weight: 0.5 });
    await upsertPreference({ publicationName: '  The   Guardian ', weight: -0.5 });
    await upsertPreference({ publicationName: 'Daily Spam', weight: -1 });

    const ctx = await loadUserGeoLanguageContext();

    // Only a positive preference fronts a card; Fewer and Mute are ranking-only.
    expect(ctx!.preferredPublications).toEqual(new Set(['the hindu']));
    expect(ctx!.publicationMultipliers).toEqual(
      new Map([
        ['the hindu', 1.5],
        ['the guardian', 0.5],
        ['daily spam', 0],
      ]),
    );
    expect(ctx).not.toHaveProperty('preferredCountriesAlpha3');
  });

  it('a retired preference no longer counts', async () => {
    const pref = await upsertPreference({ publicationName: 'The Hindu', weight: 0.5 });
    await retirePreference(pref.id);

    expect(await loadUserGeoLanguageContext()).toStrictEqual({
      homeCountryAlpha3: 'USA',
      otherCountriesAlpha3: [],
      appLanguageBase: 'en',
    });
  });

  it('a country scope row prefers that country and never lands in the publication names', async () => {
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'ind', label: 'India', weight: 0.5 });
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'CHN', label: 'China', weight: -0.5 });

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx!.preferredCountriesAlpha3).toEqual(new Set(['IND']));
    expect(ctx).not.toHaveProperty('preferredPublications');
    expect(ctx).not.toHaveProperty('publicationMultipliers');
  });

  it('subscribed sources join the preferred names and double their multiplier', async () => {
    await upsertSubscription({
      publisherId: 'pub-1',
      publisherName: 'The Hindu Group',
      countryCode: 'IN',
      sourceNames: ['The Hindu', 'Business Line'],
    });
    await upsertPreference({ publicationName: 'The Hindu', weight: 0.5 });

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx!.preferredPublications).toEqual(new Set(['the hindu', 'business line']));
    // More x1.5 times Subscribed x2 = 3; a bare subscription is x2.
    expect(ctx!.publicationMultipliers).toEqual(
      new Map([
        ['the hindu', 3],
        ['business line', 2],
      ]),
    );
  });

  it('Subscribed plus Fewer cancels to 1 and leaves the multiplier map out', async () => {
    await upsertSubscription({
      publisherId: 'pub-1',
      publisherName: 'The Guardian',
      countryCode: 'GB',
      sourceNames: ['The Guardian'],
    });
    await upsertPreference({ publicationName: 'The Guardian', weight: -0.5 });

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx!.preferredPublications).toEqual(new Set(['the guardian']));
    expect(ctx).not.toHaveProperty('publicationMultipliers');
  });

  it('Mute wins over a subscription', async () => {
    await upsertSubscription({
      publisherId: 'pub-1',
      publisherName: 'Daily Spam',
      countryCode: 'US',
      sourceNames: ['Daily Spam'],
    });
    await upsertPreference({ publicationName: 'Daily Spam', weight: -1 });

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx!.publicationMultipliers).toEqual(new Map([['daily spam', 0]]));
  });
});

describe('useUserGeoLanguageContext', () => {
  it('is null while loading, then the loaded context', async () => {
    await upsertLocation({ city: 'Mumbai', countryCode: 'IN', role: 'home', weight: 1 });

    const { result } = renderHook(() => useUserGeoLanguageContext());

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual(await loadUserGeoLanguageContext());
    expect(result.current).toMatchObject({ homeCountryAlpha3: 'IND' });
  });

  it('re-reads when the user saves a source preference', async () => {
    const { result } = renderHook(() => useUserGeoLanguageContext());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).not.toHaveProperty('preferredPublications');

    await act(async () => {
      await upsertPreference({ publicationName: 'The Hindu', weight: 0.5 });
    });

    await waitFor(() => expect(result.current?.preferredPublications).toEqual(new Set(['the hindu'])));
  });

  it('re-reads when a subscription is added', async () => {
    const { result } = renderHook(() => useUserGeoLanguageContext());
    await waitFor(() => expect(result.current).not.toBeNull());

    await act(async () => {
      await upsertSubscription({
        publisherId: 'pub-1',
        publisherName: 'The Hindu Group',
        countryCode: 'IN',
        sourceNames: ['The Hindu'],
      });
    });

    await waitFor(() => expect(result.current?.preferredPublications).toEqual(new Set(['the hindu'])));
  });

  it('re-reads when the app language changes', async () => {
    const { result } = renderHook(() => useUserGeoLanguageContext());
    await waitFor(() => expect(result.current?.appLanguageBase).toBe('en'));

    act(() => useAppLanguageStore.setState({ appLanguage: 'de' }));

    await waitFor(() => expect(result.current?.appLanguageBase).toBe('de'));
  });

  it('stays null instead of throwing when the loader fails open', async () => {
    // Persistent, not Once: the hook may load more than once. Restored below.
    const getAll = jest.spyOn(locationService, 'getAll').mockRejectedValue(new Error('db gone'));

    try {
      const { result } = renderHook(() => useUserGeoLanguageContext());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(result.current).toBeNull();
    } finally {
      getAll.mockRestore();
    }
  });
});
