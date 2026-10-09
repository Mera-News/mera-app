// Seam test for the World tab's page set: places from the real location service, browse and
// hidden countries from their settings rows, the stored order from the real page-order store,
// all on the in-memory DB. The device region is the expo-localization edge.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';
import countries from 'i18n-iso-countries';
import * as expoLocalization from 'expo-localization';
import * as expoRouter from 'expo-router';
import { deleteLocation, getAll as getAllLocations, upsertLocation } from '@/lib/database/services/location-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { addBrowseCountry, getBrowseCountries } from '@/lib/explore/browse-countries';
import { addSuppressedScopeId, getSuppressedScopeIds } from '@/lib/explore/suppressed-scopes';
import {
    addWorldCountry,
    deriveWorldPages,
    removeWorldCountry,
    useWorldPages,
    worldPageId,
    type WorldPage,
} from '@/lib/explore/world-pages';
import { resetPageOrders, usePageOrderStore } from '@/lib/navigation/page-order';

const getLocales = expoLocalization.getLocales as unknown as jest.Mock;
const useFocusEffect = expoRouter.useFocusEffect as unknown as jest.Mock;

const US_LOCALE = [{ languageCode: 'en', regionCode: 'US', languageTag: 'en-US' }];
const setDeviceRegion = (regionCode: string | null) =>
    getLocales.mockReturnValue([{ languageCode: 'en', regionCode, languageTag: 'en' }]);

const SUPPRESSED_KEY = 'explore_suppressed_scopes';
const BROWSE_KEY = 'explore_browse_countries';

const place = (countryCode: string, over: Partial<Parameters<typeof upsertLocation>[0]> = {}) =>
    upsertLocation({ city: null, region: null, countryCode, role: 'home', weight: 0.9, ...over });

/** Plain snapshot of a page, so no matcher ever sees more than ids and an origin. */
const brief = (pages: readonly WorldPage[]) => pages.map((p) => `${p.id}:${p.origin}`);
const ids = (pages: readonly WorldPage[]) => pages.map((p) => p.id);

const input = (over: Partial<Parameters<typeof deriveWorldPages>[0]> = {}) => ({
    locations: [],
    deviceCountryAlpha2: 'US',
    browseCountries: [],
    suppressedScopeIds: [],
    storedOrder: null,
    ...over,
});
const loc = (countryCode: string, weight = 0.9, role: 'home' | 'work' = 'home') =>
    ({ city: null, region: null, countryCode, role, weight }) as const;

afterEach(() => {
    getLocales.mockReturnValue(US_LOCALE);
    resetPageOrders();
});

describe('deriveWorldPages', () => {
    it('never makes a page from the device region: no places and region IN is World alone', () => {
        expect(ids(deriveWorldPages(input({ deviceCountryAlpha2: 'IN' })))).toEqual(['world']);
    });

    it('makes pages from the reader’s places and added countries, with the right origin', () => {
        const pages = deriveWorldPages(
            input({ locations: [loc('NL')], deviceCountryAlpha2: 'IN', browseCountries: ['DE'] }),
        );
        expect(brief(pages)).toEqual(['world:world', 'country:NL:place', 'country:DE:browse']);
    });

    it('takes each page id from the scope’s own alpha-2, and the scope id is alpha-3', () => {
        const [, de] = deriveWorldPages(input({ browseCountries: ['de'] }));
        expect(worldPageId(de.scope)).toBe('country:DE');
        expect(de.id).toBe('country:DE');
        expect(de.scope.id).toBe('country:DEU');
        expect(worldPageId(deriveWorldPages(input())[0].scope)).toBe('world');
    });

    it('lists a country that is both a place and a browse country once, as a place', () => {
        const pages = deriveWorldPages(input({ locations: [loc('NL')], browseCountries: ['NL', 'DE'] }));
        expect(brief(pages)).toEqual(['world:world', 'country:NL:place', 'country:DE:browse']);
    });

    it('subtracts suppressed scope ids (alpha-3) from places and browse countries', () => {
        const pages = deriveWorldPages(
            input({
                locations: [loc('NL'), loc('FR', 0.5, 'work')],
                browseCountries: ['DE'],
                suppressedScopeIds: ['country:NLD', 'country:DEU'],
            }),
        );
        expect(ids(pages)).toEqual(['world', 'country:FR']);
    });

    it('ignores suppressed ids that are not country scopes', () => {
        const pages = deriveWorldPages(input({ browseCountries: ['DE'], suppressedScopeIds: ['world', 'country:DE'] }));
        expect(ids(pages)).toEqual(['world', 'country:DE']);
    });

    it('skips an unmappable alpha-2 instead of making a page', () => {
        const pages = deriveWorldPages(input({ locations: [loc('ZZ')], browseCountries: ['QQ'] }));
        expect(ids(pages)).toEqual(['world']);
    });

    it('applies the stored order: unknown ids dropped, missing ids appended', () => {
        const pages = deriveWorldPages(
            input({
                locations: [loc('NL')],
                browseCountries: ['DE', 'FR'],
                storedOrder: ['country:FR', 'country:XX', 'world'],
            }),
        );
        expect(ids(pages)).toEqual(['country:FR', 'world', 'country:NL', 'country:DE']);
    });

    // i18n-iso-countries maps Kosovo XK to XKK; XKX is not a code it knows.
    it('Kosovo: XK round-trips as page country:XK with scope country:XKK, and XKX does not throw', () => {
        expect(() => countries.alpha3ToAlpha2('XKX')).not.toThrow();
        expect(countries.alpha3ToAlpha2('XKX')).toBeUndefined();
        const [, xk] = deriveWorldPages(input({ browseCountries: ['XK'] }));
        expect(xk.id).toBe('country:XK');
        expect(xk.scope.id).toBe('country:XKK');
        expect(xk.scope.countryCodeAlpha2).toBe('XK');
        expect(deriveWorldPages(input({ browseCountries: ['XK'], suppressedScopeIds: ['country:XKK'] }))).toHaveLength(1);
    });
});

describe('addWorldCountry and removeWorldCountry', () => {
    it('add puts a country in the browse set, normalized', async () => {
        await addWorldCountry(' de ');
        expect(await getBrowseCountries()).toEqual(['DE']);
    });

    it('add un-suppresses a hidden place country', async () => {
        await place('NL');
        await addSuppressedScopeId('country:NLD');
        await addWorldCountry('NL');
        expect(await getSuppressedScopeIds()).toEqual([]);
        expect(await getBrowseCountries()).toEqual(['NL']);
    });

    it('add ignores an unmappable code and writes nothing', async () => {
        await addWorldCountry('ZZ');
        expect(await getSetting(BROWSE_KEY)).toBeNull();
        expect(await getSetting(SUPPRESSED_KEY)).toBeNull();
    });

    it('remove on a place country suppresses it and keeps the location', async () => {
        await place('NL');
        await removeWorldCountry('nl');
        expect(await getSuppressedScopeIds()).toEqual(['country:NLD']);
        expect(await getBrowseCountries()).toEqual([]);
        expect((await getAllLocations()).map((l) => l.countryCode)).toEqual(['NL']);
    });

    it('remove suppresses a place country whatever the location’s role', async () => {
        await place('FR', { role: 'travel', weight: 0.2 });
        await removeWorldCountry('FR');
        expect(await getSuppressedScopeIds()).toEqual(['country:FRA']);
    });

    it('remove on a browse-only country deletes it from the browse set and suppresses nothing', async () => {
        await place('NL');
        await addBrowseCountry('DE');
        await removeWorldCountry('DE');
        expect(await getBrowseCountries()).toEqual([]);
        expect(await getSuppressedScopeIds()).toEqual([]);
    });

    // Mutation 1 target: a country in both reads as a place.
    it('remove on a country that is both a place and a browse country suppresses it and keeps the browse entry', async () => {
        await place('NL');
        await addBrowseCountry('NL');
        await removeWorldCountry('NL');
        expect(await getSuppressedScopeIds()).toEqual(['country:NLD']);
        expect(await getBrowseCountries()).toEqual(['NL']);
    });

    it('remove on the device-region fallback suppresses it when there is no location', async () => {
        setDeviceRegion('IN');
        await addBrowseCountry('IN');
        await removeWorldCountry('IN');
        expect(await getSuppressedScopeIds()).toEqual(['country:IND']);
        expect(await getBrowseCountries()).toEqual(['IN']);
    });

    it('remove treats the device region as a browse country once a location exists elsewhere', async () => {
        setDeviceRegion('IN');
        await place('NL');
        await addBrowseCountry('IN');
        await removeWorldCountry('IN');
        expect(await getSuppressedScopeIds()).toEqual([]);
        expect(await getBrowseCountries()).toEqual([]);
    });

    it('remove ignores an unmappable code', async () => {
        await addBrowseCountry('DE');
        await removeWorldCountry('ZZ');
        expect(await getBrowseCountries()).toEqual(['DE']);
        expect(await getSetting(SUPPRESSED_KEY)).toBeNull();
    });

    it('remove then add restores a hidden place country', async () => {
        await place('NL');
        await removeWorldCountry('NL');
        await addWorldCountry('NL');
        expect(await getSuppressedScopeIds()).toEqual([]);
    });

    it('a restored backup row with legacy city and region entries stays clean through a remove', async () => {
        await place('NL');
        await setSetting(SUPPRESSED_KEY, JSON.stringify(['city:IND:mumbai', 'region:FRA:bretagne']));
        await removeWorldCountry('NL');
        expect(JSON.parse((await getSetting(SUPPRESSED_KEY))!)).toEqual(['country:NLD']);
    });

    it('Kosovo: add and remove round-trip through XK / XKK', async () => {
        await place('XK');
        await removeWorldCountry('XK');
        expect(await getSuppressedScopeIds()).toEqual(['country:XKK']);
        await addWorldCountry('XK');
        expect(await getSuppressedScopeIds()).toEqual([]);
    });
});

describe('useWorldPages', () => {
    beforeEach(() => {
        // The integration expo-router stubs useFocusEffect to a no-op; run the effect as a focused screen does.
        useFocusEffect.mockImplementation((cb: () => void | (() => void)) => React.useEffect(cb, [cb]));
    });
    afterAll(() => {
        useFocusEffect.mockReset();
    });

    it('loads once the locations have emitted, and lists World alone with none', async () => {
        const empty = renderHook(() => useWorldPages());
        await waitFor(() => expect(empty.result.current.loaded).toBe(true));
        expect(ids(empty.result.current.pages)).toEqual(['world']);
        empty.unmount();

        await place('NL');
        const { result } = renderHook(() => useWorldPages());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(brief(result.current.pages)).toEqual(['world:world', 'country:NL:place']);
    });

    it('re-derives when a location row is added or removed underneath it', async () => {
        const { result } = renderHook(() => useWorldPages());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(ids(result.current.pages)).toEqual(['world']);

        await act(async () => {
            await place('NL');
        });
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:NL']));

        await act(async () => {
            for (const l of await getAllLocations()) await deleteLocation(l.id);
        });
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world']));
    });

    it('re-reads the browse and hidden rows after addWorldCountry and removeWorldCountry', async () => {
        await place('NL');
        const { result } = renderHook(() => useWorldPages());
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:NL']));

        await act(async () => {
            await addWorldCountry('DE');
        });
        await waitFor(() => expect(brief(result.current.pages)).toEqual(['world:world', 'country:NL:place', 'country:DE:browse']));

        await act(async () => {
            await removeWorldCountry('NL');
        });
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:DE']));

        await act(async () => {
            await removeWorldCountry('DE');
        });
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world']));

        await act(async () => {
            await addWorldCountry('NL');
        });
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:NL']));
    });

    it('returns the same pages array when a re-read finds nothing new', async () => {
        await place('NL');
        const { result } = renderHook(() => useWorldPages());
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:NL']));
        await act(async () => {
            await addWorldCountry('DE');
        });
        await waitFor(() => expect(ids(result.current.pages)).toContain('country:DE'));
        const before = result.current.pages;
        await act(async () => {
            await addWorldCountry('DE');
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(result.current.pages).toBe(before);
    });

    it('follows the stored World order from the page-order store', async () => {
        await place('NL');
        await addBrowseCountry('DE');
        const { result } = renderHook(() => useWorldPages());
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:NL', 'country:DE']));
        act(() => {
            usePageOrderStore.setState({ stored: ['country:DE', 'world', 'country:NL'] });
        });
        expect(ids(result.current.pages)).toEqual(['country:DE', 'world', 'country:NL']);
    });

    it('picks up rows another screen wrote when it mounts', async () => {
        await addBrowseCountry('FR');
        await addSuppressedScopeId('country:FRA');
        await addBrowseCountry('DE');
        const { result } = renderHook(() => useWorldPages());
        await waitFor(() => expect(ids(result.current.pages)).toEqual(['world', 'country:DE']));
    });

    it('stops listening after unmount', async () => {
        const { result, unmount } = renderHook(() => useWorldPages());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        unmount();
        await expect(addWorldCountry('DE')).resolves.toBeUndefined();
    });
});
