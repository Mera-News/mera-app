let store: Record<string, string> = {};
const mockGetSetting = jest.fn((key: string) => Promise.resolve(store[key] ?? null));
const mockSetSetting = jest.fn((key: string, value: string) => {
  store[key] = value;
  return Promise.resolve();
});
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
}));

import {
  addBrowseCountry,
  getBrowseCountries,
  mergeBrowseCountries,
  removeBrowseCountry,
} from '../browse-countries';

const KEY = 'explore_browse_countries';

beforeEach(() => {
  store = {};
  mockGetSetting.mockClear();
  mockSetSetting.mockClear();
});

describe('mergeBrowseCountries (pure)', () => {
  it('appends a new code', () => {
    expect(mergeBrowseCountries(['US'], 'FR')).toEqual(['US', 'FR']);
  });

  it('is idempotent — merging an already-present code changes nothing', () => {
    expect(mergeBrowseCountries(['US', 'FR'], 'FR')).toEqual(['US', 'FR']);
  });

  it('case-normalizes both the existing list and the incoming code', () => {
    expect(mergeBrowseCountries(['us'], 'FR')).toEqual(['US', 'FR']);
    expect(mergeBrowseCountries(['US'], 'fr')).toEqual(['US', 'FR']);
    expect(mergeBrowseCountries(['us'], 'US')).toEqual(['US']);
  });

  it('trims whitespace', () => {
    expect(mergeBrowseCountries([' US '], ' fr ')).toEqual(['US', 'FR']);
  });

  it('dedupes the existing list itself, order-preserving', () => {
    expect(mergeBrowseCountries(['US', 'us', 'FR'], 'DE')).toEqual(['US', 'FR', 'DE']);
  });

  it('drops empty/blank entries from the existing list', () => {
    expect(mergeBrowseCountries(['US', '', '  '], 'FR')).toEqual(['US', 'FR']);
  });

  it('returns the deduped existing list unchanged when the incoming code is blank', () => {
    expect(mergeBrowseCountries(['US', 'us'], '  ')).toEqual(['US']);
  });

  it('treats a null/undefined incoming code as blank rather than throwing', () => {
    expect(mergeBrowseCountries(['US'], null as unknown as string)).toEqual(['US']);
    expect(mergeBrowseCountries(['US'], undefined as unknown as string)).toEqual(['US']);
  });
});

describe('getBrowseCountries', () => {
  it('resolves to [] when nothing is stored', async () => {
    expect(await getBrowseCountries()).toEqual([]);
  });

  it('resolves to [] for garbage JSON rather than throwing', async () => {
    store[KEY] = 'not json{{{';
    expect(await getBrowseCountries()).toEqual([]);
  });

  it('resolves to [] when the stored value is valid JSON but not an array', async () => {
    store[KEY] = JSON.stringify({ US: true });
    expect(await getBrowseCountries()).toEqual([]);
  });

  it('filters out non-string members', async () => {
    store[KEY] = JSON.stringify(['US', 42, null, 'FR']);
    expect(await getBrowseCountries()).toEqual(['US', 'FR']);
  });

  it('dedupes and case-normalizes stored entries', async () => {
    store[KEY] = JSON.stringify(['us', 'US', ' fr ']);
    expect(await getBrowseCountries()).toEqual(['US', 'FR']);
  });
});

describe('addBrowseCountry', () => {
  it('adds a country to an empty set', async () => {
    expect(await addBrowseCountry('fr')).toEqual(['FR']);
    expect(await getBrowseCountries()).toEqual(['FR']);
  });

  it('is idempotent — adding the same country twice does not duplicate it', async () => {
    await addBrowseCountry('FR');
    expect(await addBrowseCountry('fr')).toEqual(['FR']);
    expect(await getBrowseCountries()).toEqual(['FR']);
  });

  it('appends to an existing set', async () => {
    await addBrowseCountry('US');
    expect(await addBrowseCountry('DE')).toEqual(['US', 'DE']);
  });
});

describe('removeBrowseCountry', () => {
  it('is a no-op on an empty set', async () => {
    expect(await removeBrowseCountry('US')).toEqual([]);
  });

  it('removes a present country', async () => {
    await addBrowseCountry('US');
    await addBrowseCountry('FR');
    expect(await removeBrowseCountry('us')).toEqual(['FR']);
  });

  it('is idempotent — removing an absent country changes nothing', async () => {
    await addBrowseCountry('FR');
    expect(await removeBrowseCountry('DE')).toEqual(['FR']);
    expect(await removeBrowseCountry('DE')).toEqual(['FR']);
  });
});
