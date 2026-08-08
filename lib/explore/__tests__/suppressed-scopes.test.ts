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
  addSuppressedScopeId,
  getSuppressedScopeIds,
  removeSuppressedScopeId,
} from '../suppressed-scopes';

const KEY = 'explore_suppressed_scopes';

beforeEach(() => {
  store = {};
  mockGetSetting.mockClear();
  mockSetSetting.mockClear();
});

describe('getSuppressedScopeIds', () => {
  it('resolves to [] when nothing is stored', async () => {
    expect(await getSuppressedScopeIds()).toEqual([]);
  });

  it('resolves to [] for garbage JSON rather than throwing', async () => {
    store[KEY] = '{not valid';
    expect(await getSuppressedScopeIds()).toEqual([]);
  });

  it('resolves to [] when the stored value is valid JSON but not an array', async () => {
    store[KEY] = JSON.stringify('country:IND');
    expect(await getSuppressedScopeIds()).toEqual([]);
  });

  it('filters non-string members and dedupes', async () => {
    store[KEY] = JSON.stringify(['country:IND', 7, 'country:IND', 'country:FRA']);
    expect(await getSuppressedScopeIds()).toEqual(['country:IND', 'country:FRA']);
  });

  it('never surfaces "world" even if it was somehow persisted', async () => {
    store[KEY] = JSON.stringify(['world', 'country:IND']);
    expect(await getSuppressedScopeIds()).toEqual(['country:IND']);
  });
});

describe('addSuppressedScopeId', () => {
  it('adds an id to an empty set', async () => {
    expect(await addSuppressedScopeId('country:IND')).toEqual(['country:IND']);
  });

  it('is idempotent', async () => {
    await addSuppressedScopeId('country:IND');
    expect(await addSuppressedScopeId('country:IND')).toEqual(['country:IND']);
  });

  it('refuses to hide "world"', async () => {
    expect(await addSuppressedScopeId('world')).toEqual([]);
    expect(await getSuppressedScopeIds()).toEqual([]);
  });

  it('appends to an existing set', async () => {
    await addSuppressedScopeId('country:IND');
    expect(await addSuppressedScopeId('country:FRA')).toEqual(['country:IND', 'country:FRA']);
  });

  it('treats a null/undefined id as blank rather than throwing', async () => {
    expect(await addSuppressedScopeId(null as unknown as string)).toEqual([]);
    expect(await addSuppressedScopeId(undefined as unknown as string)).toEqual([]);
  });
});

describe('removeSuppressedScopeId', () => {
  it('is a no-op on an empty set', async () => {
    expect(await removeSuppressedScopeId('country:IND')).toEqual([]);
  });

  it('removes a present id', async () => {
    await addSuppressedScopeId('country:IND');
    await addSuppressedScopeId('country:FRA');
    expect(await removeSuppressedScopeId('country:IND')).toEqual(['country:FRA']);
  });

  it('is idempotent', async () => {
    await addSuppressedScopeId('country:IND');
    expect(await removeSuppressedScopeId('country:FRA')).toEqual(['country:IND']);
    expect(await removeSuppressedScopeId('country:FRA')).toEqual(['country:IND']);
  });
});
