import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockRows = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockRows.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockRows.set(k, v);
  }),
}));

type Loc = { city: string | null; region: string | null; countryCode: string; role: string; weight: number };
let mockLocations: Loc[] = [];
const mockLocationListeners = new Set<(rows: Loc[]) => void>();
jest.mock('@/lib/database/services/location-service', () => ({
  getAll: jest.fn(async () => mockLocations),
  observeAll: () => ({
    subscribe: (fn: (rows: Loc[]) => void) => {
      mockLocationListeners.add(fn);
      fn(mockLocations);
      return { unsubscribe: () => mockLocationListeners.delete(fn) };
    },
  }),
}));

let mockDeviceCountry = 'US';
jest.mock('../device-country', () => ({ getDeviceCountryAlpha2: () => mockDeviceCountry }));

jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return { useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]) };
});
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import { resetPageOrders, setPageOrder } from '@/lib/navigation/page-order';
import { alpha2ToAlpha3, deriveExploreScopes, type ScopeLocationInput } from '../scopes';
import {
  addWorldCountry,
  deriveWorldPages,
  markWorldIntroDone,
  readWorldIntroDone,
  removeWorldCountry,
  useWorldIntroDone,
  useWorldPages,
  worldPageId,
} from '../world-pages';

const loc = (countryCode: string, role: ScopeLocationInput['role'], weight: number, city: string | null = null) =>
  ({ city, region: null, countryCode, role, weight }) as ScopeLocationInput;

const base = { deviceCountryAlpha2: 'US', browseCountries: [], suppressedScopeIds: [], storedOrder: null };

beforeEach(() => {
  mockRows.clear();
  mockLocations = [];
  mockDeviceCountry = 'US';
  resetPageOrders();
});

describe('deriveWorldPages', () => {
  it('World first, then the primary country, places by weight, then browse countries', () => {
    const pages = deriveWorldPages({
      ...base,
      locations: [loc('FR', 'interest', 0.9, 'paris'), loc('IN', 'home', 0.6, 'mumbai')],
      browseCountries: ['jp', 'FR'],
    });
    expect(pages.map((p) => [p.id, p.origin])).toEqual([
      ['world', 'world'],
      ['country:IN', 'place'],
      ['country:FR', 'place'],
      ['country:JP', 'browse'],
    ]);
  });

  it('never makes a city or region page', () => {
    const pages = deriveWorldPages({ ...base, locations: [loc('DE', 'home', 1, 'berlin')] });
    expect(pages.every((p) => p.scope.kind === 'world' || p.scope.kind === 'country')).toBe(true);
    expect(pages.map((p) => p.id)).toEqual(['world', 'country:DE']);
  });

  it('the device region counts as a place when there are no locations', () => {
    expect(deriveWorldPages({ ...base, locations: [] }).map((p) => [p.id, p.origin])).toEqual([
      ['world', 'world'],
      ['country:US', 'place'],
    ]);
  });

  it('hides suppressed countries (by alpha-3 scope id), never World', () => {
    const pages = deriveWorldPages({
      ...base,
      locations: [loc('DE', 'home', 1)],
      suppressedScopeIds: ['country:DEU', 'world'],
    });
    expect(pages.map((p) => p.id)).toEqual(['world']);
  });

  it('applies the stored order; unknown ids drop, new pages append', () => {
    const pages = deriveWorldPages({
      ...base,
      locations: [loc('DE', 'home', 1)],
      browseCountries: ['JP', 'BR'],
      storedOrder: ['country:JP', 'country:XX', 'world', 'country:DE'],
    });
    expect(pages.map((p) => p.id)).toEqual(['country:JP', 'world', 'country:DE', 'country:BR']);
  });

  // The two id formats: page `country:<alpha2>`, scope `country:<ALPHA3>`.
  // Every scope the derivation emits must round-trip, Kosovo (XK, XKK in
  // i18n-iso-countries) included.
  it('every emitted country round-trips alpha-2 page id to alpha-3 scope id', () => {
    const codes = ['XK', 'DE', 'GB', 'US', 'IN', 'BR', 'JP', 'NZ', 'ZA', 'AE', 'PS', 'TW', 'HK'];
    const scopes = deriveExploreScopes([], null, codes).filter((s) => s.kind === 'country');
    expect(scopes).toHaveLength(codes.length);
    for (const scope of scopes) {
      const id = worldPageId(scope);
      const alpha2 = id.slice('country:'.length);
      expect(`country:${alpha2ToAlpha3(alpha2)}`).toBe(scope.id);
    }
    expect(scopes.find((s) => s.countryCodeAlpha2 === 'XK')?.id).toBe('country:XKK');
  });
});

describe('add and remove', () => {
  it('add puts the country in the browse set and un-hides it', async () => {
    mockRows.set('explore_suppressed_scopes', '["country:DEU","country:FRA"]');
    await addWorldCountry('de');
    expect(JSON.parse(mockRows.get('explore_browse_countries')!)).toEqual(['DE']);
    expect(JSON.parse(mockRows.get('explore_suppressed_scopes')!)).toEqual(['country:FRA']);
  });

  it('removing a place country hides it and keeps the browse set', async () => {
    mockLocations = [loc('DE', 'home', 1)];
    mockRows.set('explore_browse_countries', '["DE","JP"]');
    await removeWorldCountry('DE');
    expect(JSON.parse(mockRows.get('explore_suppressed_scopes')!)).toEqual(['country:DEU']);
    expect(JSON.parse(mockRows.get('explore_browse_countries')!)).toEqual(['DE', 'JP']);
  });

  it('removing the device-region page hides it', async () => {
    mockDeviceCountry = 'NL';
    await removeWorldCountry('nl');
    expect(JSON.parse(mockRows.get('explore_suppressed_scopes')!)).toEqual(['country:NLD']);
  });

  it('removing a browse-only country deletes it from the browse set', async () => {
    mockLocations = [loc('DE', 'home', 1)];
    mockRows.set('explore_browse_countries', '["JP","BR"]');
    await removeWorldCountry('JP');
    expect(JSON.parse(mockRows.get('explore_browse_countries')!)).toEqual(['BR']);
    expect(mockRows.has('explore_suppressed_scopes')).toBe(false);
  });

  it('ignores a code that is not a country', async () => {
    await addWorldCountry('ZZ');
    await removeWorldCountry('');
    expect(mockRows.size).toBe(0);
  });
});

describe('World intro line', () => {
  it('is not done until marked', async () => {
    expect(await readWorldIntroDone()).toBe(false);
    await markWorldIntroDone();
    expect(mockRows.get('nav_world_intro_done')).toBe('1');
    expect(await readWorldIntroDone()).toBe(true);
  });

  it('the hook reads null, then the value, and follows a mark', async () => {
    const { result } = renderHook(() => useWorldIntroDone());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));
    await act(async () => {
      await markWorldIntroDone();
    });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe('useWorldPages', () => {
  it('derives pages, follows adds and order changes, and keeps arrays on equal re-reads', async () => {
    mockLocations = [loc('DE', 'home', 1)];
    const { result } = renderHook(() => useWorldPages());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.pages.map((p) => p.id)).toEqual(['world', 'country:DE']);

    await act(async () => {
      await addWorldCountry('JP');
    });
    await waitFor(() => expect(result.current.pages.map((p) => p.id)).toEqual(['world', 'country:DE', 'country:JP']));

    const before = result.current.pages;
    act(() => {
      for (const fn of mockLocationListeners) fn([...mockLocations]);
    });
    expect(result.current.pages).toBe(before);

    act(() => setPageOrder('world', ['country:JP', 'world', 'country:DE']));
    expect(result.current.pages.map((p) => p.id)).toEqual(['country:JP', 'world', 'country:DE']);
  });
});
