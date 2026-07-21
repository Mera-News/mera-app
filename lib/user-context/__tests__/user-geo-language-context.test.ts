// user-geo-language-context.test.ts — the RN-coupled loader + hook. The DB
// location service, the alpha2→alpha3 converter, the device-country resolver,
// and the app-language store are all mocked; the pure priority helpers run for
// real.

import { renderHook, waitFor } from '@testing-library/react-native';

const mockGetAll = jest.fn();
const mockGetDeviceCountryAlpha2 = jest.fn();
const mockAppLanguageGetState = jest.fn();
const mockUseAppLanguage = jest.fn();

jest.mock('@/lib/database/services/location-service', () => ({
  getAll: (...args: any[]) => mockGetAll(...args),
}));

// Deterministic alpha2→alpha3 mock (mirrors the real trim/upper-case + null-on-
// unknown contract) so "conversion failure" is testable without i18n data.
const ALPHA_MAP: Record<string, string> = { US: 'USA', GB: 'GBR', IN: 'IND', FR: 'FRA' };
jest.mock('@/lib/explore/scopes', () => ({
  alpha2ToAlpha3: (a2: string | null | undefined) => {
    const key = (a2 ?? '').trim().toUpperCase();
    return ALPHA_MAP[key] ?? null;
  },
}));

jest.mock('@/lib/explore/device-country', () => ({
  getDeviceCountryAlpha2: (...args: any[]) => mockGetDeviceCountryAlpha2(...args),
}));

jest.mock('@/lib/stores/app-language-store', () => ({
  useAppLanguageStore: {
    getState: (...args: any[]) => mockAppLanguageGetState(...args),
  },
  useAppLanguage: (...args: any[]) => mockUseAppLanguage(...args),
}));

import {
  loadUserGeoLanguageContext,
  useUserGeoLanguageContext,
} from '../user-geo-language-context';

// Minimal Location-model stand-in (only the fields the loader reads).
function loc(overrides: { id: string; countryCode: string; role: string; weight?: number }) {
  return { weight: overrides.weight ?? 0.5, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAll.mockResolvedValue([]);
  mockGetDeviceCountryAlpha2.mockReturnValue('US');
  mockAppLanguageGetState.mockReturnValue({ appLanguage: 'en' });
  mockUseAppLanguage.mockReturnValue('en');
});

// ===========================================================================
// loadUserGeoLanguageContext
// ===========================================================================

describe('loadUserGeoLanguageContext', () => {
  it('uses the first home-role location as home and the rest (weight order) as others', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'US', role: 'home', weight: 0.9 }),
      loc({ id: '2', countryCode: 'GB', role: 'travel', weight: 0.7 }),
      loc({ id: '3', countryCode: 'IN', role: 'family', weight: 0.5 }),
    ]);

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx).toEqual({
      homeCountryAlpha3: 'USA',
      otherCountriesAlpha3: ['GBR', 'IND'],
      appLanguageBase: 'en',
    });
  });

  it('excludes the home country from others and dedupes repeated countries', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'US', role: 'home' }),
      loc({ id: '2', countryCode: 'US', role: 'travel' }), // same as home → dropped
      loc({ id: '3', countryCode: 'GB', role: 'family' }),
      loc({ id: '4', countryCode: 'GB', role: 'travel' }), // dup → dropped
    ]);

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx?.homeCountryAlpha3).toBe('USA');
    expect(ctx?.otherCountriesAlpha3).toEqual(['GBR']);
  });

  it('falls back to the device country when there is no home-role location', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'GB', role: 'travel' }),
    ]);
    mockGetDeviceCountryAlpha2.mockReturnValue('US');

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx?.homeCountryAlpha3).toBe('USA'); // from device
    expect(ctx?.otherCountriesAlpha3).toEqual(['GBR']);
  });

  it('falls back to the device country when the home-role code is unmappable', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'ZZ', role: 'home' }), // unmappable
      loc({ id: '2', countryCode: 'GB', role: 'travel' }),
    ]);
    mockGetDeviceCountryAlpha2.mockReturnValue('US');

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx?.homeCountryAlpha3).toBe('USA');
    expect(ctx?.otherCountriesAlpha3).toEqual(['GBR']);
  });

  it('empty locations → home from device country, no others', async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetDeviceCountryAlpha2.mockReturnValue('US');

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx).toEqual({
      homeCountryAlpha3: 'USA',
      otherCountriesAlpha3: [],
      appLanguageBase: 'en',
    });
  });

  it('drops locations whose alpha2→alpha3 conversion fails', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'US', role: 'home' }),
      loc({ id: '2', countryCode: 'ZZ', role: 'travel' }), // unmappable → dropped
      loc({ id: '3', countryCode: 'GB', role: 'family' }),
    ]);

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx?.otherCountriesAlpha3).toEqual(['GBR']);
  });

  it('reads the app-language base from the store (zh-Hans → zh)', async () => {
    mockAppLanguageGetState.mockReturnValue({ appLanguage: 'zh-Hans' });

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx?.appLanguageBase).toBe('zh');
  });

  it('null home + null device country → home null, others still built', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'GB', role: 'travel' }),
    ]);
    mockGetDeviceCountryAlpha2.mockReturnValue('ZZ'); // unmappable

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx?.homeCountryAlpha3).toBeNull();
    expect(ctx?.otherCountriesAlpha3).toEqual(['GBR']);
  });

  it('fails open to null on a thrown error', async () => {
    mockGetAll.mockRejectedValue(new Error('db down'));

    const ctx = await loadUserGeoLanguageContext();

    expect(ctx).toBeNull();
  });
});

// ===========================================================================
// useUserGeoLanguageContext
// ===========================================================================

describe('useUserGeoLanguageContext', () => {
  it('starts null then resolves the loaded context', async () => {
    mockGetAll.mockResolvedValue([
      loc({ id: '1', countryCode: 'US', role: 'home' }),
    ]);

    const { result } = renderHook(() => useUserGeoLanguageContext());

    expect(result.current).toBeNull(); // initial, pre-load
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.homeCountryAlpha3).toBe('USA');
  });

  it('re-runs the loader when the app language changes', async () => {
    mockGetAll.mockResolvedValue([]);
    mockUseAppLanguage.mockReturnValue('en');

    const { result, rerender } = renderHook(() => useUserGeoLanguageContext());
    await waitFor(() => expect(result.current).not.toBeNull());
    const callsAfterFirst = mockGetAll.mock.calls.length;

    mockUseAppLanguage.mockReturnValue('fr');
    rerender({});

    await waitFor(() => expect(mockGetAll.mock.calls.length).toBeGreaterThan(callsAfterFirst));
  });
});
