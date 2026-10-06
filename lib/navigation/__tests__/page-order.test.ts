const mockRows = new Map<string, string>();
const mockGetSetting = jest.fn(async (k: string) => mockRows.get(k) ?? null);
const mockSetSetting = jest.fn(async (k: string, v: string) => {
  mockRows.set(k, v);
});
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (k: string) => mockGetSetting(k),
  setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import {
  applyPageOrder,
  DEFAULT_PAGE_ORDER,
  loadPageOrders,
  parsePageOrder,
  resetPageOrders,
  setPageOrder,
  usePageOrderStore,
} from '../page-order';

beforeEach(() => {
  mockRows.clear();
  jest.clearAllMocks();
  resetPageOrders();
});

describe('applyPageOrder', () => {
  const defaults = DEFAULT_PAGE_ORDER.library;

  it('returns the defaults when nothing is stored', () => {
    expect(applyPageOrder(null, defaults)).toEqual(['saved', 'checks', 'visited', 'stats']);
  });

  it('applies a stored order', () => {
    expect(applyPageOrder(['stats', 'visited', 'checks', 'saved'], defaults)).toEqual([
      'stats', 'visited', 'checks', 'saved',
    ]);
  });

  it('drops unknown ids and appends missing ones in default order', () => {
    expect(applyPageOrder(['visited', 'country:DE', 'gone', 'saved'], defaults)).toEqual([
      'visited', 'saved', 'checks', 'stats',
    ]);
  });

  it('drops duplicates', () => {
    expect(applyPageOrder(['stats', 'stats', 'saved'], defaults)).toEqual([
      'stats', 'saved', 'checks', 'visited',
    ]);
  });
});

describe('parsePageOrder', () => {
  it.each([null, '', 'not json', '{"a":1}', '42'])('reads %p as no order', (raw) => {
    expect(parsePageOrder(raw)).toBeNull();
  });

  it('keeps only string members', () => {
    expect(parsePageOrder('["feed", 3, null, "stories"]')).toEqual(['feed', 'stories']);
  });
});

describe('store', () => {
  it('loads every tab row once, however often it is asked', async () => {
    mockRows.set('nav_order_you', '["settings","profile"]');
    await Promise.all([loadPageOrders(), loadPageOrders()]);
    await loadPageOrders();
    expect(mockGetSetting).toHaveBeenCalledTimes(4);
    expect(usePageOrderStore.getState()).toMatchObject({
      hydrated: true,
      stored: { feed: null, world: null, library: null, you: ['settings', 'profile'] },
    });
  });

  it('marks hydrated even when the read fails', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('db'));
    await loadPageOrders();
    expect(usePageOrderStore.getState().hydrated).toBe(true);
  });

  it('setPageOrder updates the store at once and persists the row', async () => {
    setPageOrder('world', ['country:DE', 'world', 'country:DE']);
    expect(usePageOrderStore.getState().stored.world).toEqual(['country:DE', 'world']);
    await Promise.resolve();
    expect(mockSetSetting).toHaveBeenCalledWith('nav_order_world', '["country:DE","world"]');
  });

  it('a load started before a reset never writes the old account into the store', async () => {
    mockRows.set('nav_order_feed', '["stories"]');
    const stale = loadPageOrders();
    resetPageOrders();
    await stale;
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: false, stored: { feed: null } });
  });
});
