// user-geo-language-context.test.ts — the RN-coupled loader + hook. The DB
// location service, the alpha2→alpha3 converter, the device-country resolver,
// and the app-language store are all mocked; the pure priority helpers run for
// real.

import { renderHook, waitFor } from '@testing-library/react-native';

const mockGetAll = jest.fn();
const mockGetDeviceCountryAlpha2 = jest.fn();
const mockAppLanguageGetState = jest.fn();
const mockUseAppLanguage = jest.fn();
// source-pref: the loader now also reads the user's explicit source
// preferences. Mocked exactly like location-service above — a static import of
// the real service pulls in the SQLite adapter singleton at module load.
const mockGetActivePubPrefs = jest.fn();
const mockObserveActivePubPrefs = jest.fn();

jest.mock('@/lib/database/services/location-service', () => ({
  getAll: (...args: any[]) => mockGetAll(...args),
}));

jest.mock('@/lib/database/services/publication-preference-service', () => ({
  getActive: (...args: any[]) => mockGetActivePubPrefs(...args),
  observeActive: (...args: any[]) => mockObserveActivePubPrefs(...args),
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
  mockGetActivePubPrefs.mockResolvedValue([]);
  mockObserveActivePubPrefs.mockReturnValue({
    subscribe: () => ({ unsubscribe: () => {} }),
  });
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

// ===========================================================================
// source preferences (source-pref, D2/D3/D6)
// ===========================================================================

/** Minimal PublicationPreference stand-in (only the fields the loader reads). */
function pref(o: {
  publicationName: string;
  weight: number;
  scopeKind?: string | null;
  scopeValue?: string | null;
}) {
  return { scopeKind: null, scopeValue: null, ...o };
}

describe('loadUserGeoLanguageContext — source preferences', () => {
  it('collects positively-weighted NAMED publications, normalized', () => {
    mockGetActivePubPrefs.mockResolvedValue([
      pref({ publicationName: '  Times   OF India ', weight: 0.5 }),
    ]);
    return loadUserGeoLanguageContext().then((ctx) => {
      expect(ctx!.preferredPublications).toEqual(new Set(['times of india']));
      expect(ctx!.preferredCountriesAlpha3).toBeUndefined();
    });
  });

  it('collects country SCOPE rows by scope_value, not by their display label', () => {
    // The label lives in publication_name so the existing screen renders the
    // row; it must never be read as a publication name.
    mockGetActivePubPrefs.mockResolvedValue([
      pref({ publicationName: 'India', weight: 0.5, scopeKind: 'country', scopeValue: 'ind' }),
    ]);
    return loadUserGeoLanguageContext().then((ctx) => {
      expect(ctx!.preferredCountriesAlpha3).toEqual(new Set(['IND']));
      expect(ctx!.preferredPublications).toBeUndefined();
    });
  });

  it('ignores non-positive weights — a downrank or mute is not a preference', () => {
    mockGetActivePubPrefs.mockResolvedValue([
      pref({ publicationName: 'Daily Mail', weight: -0.5 }),
      pref({ publicationName: 'Tabloid', weight: -1 }),
      pref({ publicationName: 'Neutral', weight: 0 }),
    ]);
    return loadUserGeoLanguageContext().then((ctx) => {
      expect(ctx!.preferredPublications).toBeUndefined();
      expect(ctx!.preferredCountriesAlpha3).toBeUndefined();
    });
  });

  it('ignores an unknown future scope kind rather than guessing it is a publication', () => {
    mockGetActivePubPrefs.mockResolvedValue([
      pref({ publicationName: 'Sport', weight: 0.5, scopeKind: 'category', scopeValue: 'sport' }),
    ]);
    return loadUserGeoLanguageContext().then((ctx) => {
      expect(ctx!.preferredPublications).toBeUndefined();
      expect(ctx!.preferredCountriesAlpha3).toBeUndefined();
    });
  });

  it('REGRESSION CONTRACT: no preferences ⇒ the context object shape is unchanged', () => {
    mockGetActivePubPrefs.mockResolvedValue([]);
    return loadUserGeoLanguageContext().then((ctx) => {
      expect(Object.keys(ctx!).sort()).toEqual([
        'appLanguageBase',
        'homeCountryAlpha3',
        'otherCountriesAlpha3',
      ]);
    });
  });

  it('fails open to null when the preference read throws', () => {
    mockGetActivePubPrefs.mockRejectedValue(new Error('db gone'));
    return loadUserGeoLanguageContext().then((ctx) => {
      expect(ctx).toBeNull();
    });
  });
});

describe('useUserGeoLanguageContext — preference refresh seam', () => {
  it('re-loads when active source preferences change', async () => {
    // Without this the whole feature would appear dead: it is applied at render
    // time, but a hook memoized on [appLanguage] alone would not re-read the
    // preferences until the language changed or the screen remounted.
    let emit: (() => void) | null = null;
    mockObserveActivePubPrefs.mockReturnValue({
      subscribe: (cb: () => void) => {
        emit = cb;
        return { unsubscribe: () => {} };
      },
    });
    mockGetActivePubPrefs.mockResolvedValue([]);

    const { result } = renderHook(() => useUserGeoLanguageContext());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.preferredPublications).toBeUndefined();

    mockGetActivePubPrefs.mockResolvedValue([
      pref({ publicationName: 'Times of India', weight: 0.5 }),
    ]);
    emit!();
    await waitFor(() =>
      expect(result.current!.preferredPublications).toEqual(new Set(['times of india'])),
    );
  });

  it('still resolves a context when the preference observable cannot be built', async () => {
    mockObserveActivePubPrefs.mockImplementation(() => {
      throw new Error('no db');
    });
    const { result } = renderHook(() => useUserGeoLanguageContext());
    await waitFor(() => expect(result.current).not.toBeNull());
  });
});
