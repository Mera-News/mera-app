// Page order: the pure merge, the `nav_order_*` rows, and the memoised World
// load with its reset guard. Replaces lib/navigation/__tests__/page-order.test.ts
// (which mocked setting-service).
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  DEFAULT_PAGE_ORDER,
  applyPageOrder,
  loadPageOrders,
  parsePageOrder,
  resetPageOrders,
  setWorldPageOrder,
  usePageOrderStore,
} from '@/lib/navigation/page-order';
import { countSettingReads, failSettingRead, holdNextSettingResult, persisted, restoreFaults } from './support';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

const WORLD = 'nav_order_world';

beforeEach(() => resetPageOrders());
afterEach(() => restoreFaults());

describe('applyPageOrder against DEFAULT_PAGE_ORDER', () => {
  const library = DEFAULT_PAGE_ORDER.library;

  it('returns the defaults when nothing is stored', () => {
    expect(applyPageOrder(null, library)).toEqual(['saved', 'checks', 'visited', 'stats']);
    expect(applyPageOrder(undefined, library)).toEqual(['saved', 'checks', 'visited', 'stats']);
  });

  it('applies a stored order', () => {
    expect(applyPageOrder(['stats', 'visited', 'checks', 'saved'], library)).toEqual(['stats', 'visited', 'checks', 'saved']);
  });

  it('drops unknown ids and appends missing ones in default order', () => {
    expect(applyPageOrder(['visited', 'country:DE', 'gone', 'saved'], library)).toEqual(['visited', 'saved', 'checks', 'stats']);
  });

  it('appends a page added since an old order was saved', () => {
    expect(applyPageOrder(['saved', 'checks', 'visited'], library)).toEqual(['saved', 'checks', 'visited', 'stats']);
  });

  it('drops duplicates', () => {
    expect(applyPageOrder(['visited', 'visited', 'saved'], library)).toEqual(['visited', 'saved', 'checks', 'stats']);
  });

  it('an empty stored list reads as the defaults', () => {
    expect(applyPageOrder([], DEFAULT_PAGE_ORDER.you)).toEqual(['profile', 'settings']);
  });

  it.each(['feed', 'library', 'you'] as const)('a seeded nav_order_%s row reads through parsePageOrder and applyPageOrder', async (tab) => {
    const defaults = DEFAULT_PAGE_ORDER[tab];
    const reversed = [...defaults].reverse();
    await setSetting(`nav_order_${tab}`, JSON.stringify([...reversed, 'country:DE']));
    const order = applyPageOrder(parsePageOrder(await getSetting(`nav_order_${tab}`)), defaults);
    expect(order).toEqual(reversed);
  });
});

describe('parsePageOrder', () => {
  it.each([null, undefined, '', 'not json', '{"a":1}', '42'])('reads %p as no order', (raw) => {
    expect(parsePageOrder(raw)).toBeNull();
  });

  it('keeps only string members', () => {
    expect(parsePageOrder('["feed", 3, null, "stories"]')).toEqual(['feed', 'stories']);
  });
});

describe('loadPageOrders', () => {
  it("loads World's row once, however often it is asked, and reads no other nav row", async () => {
    await setSetting(WORLD, '["country:DE","world"]');
    await setSetting('nav_order_you', '["settings","profile"]');
    const worldReads = countSettingReads(WORLD);
    const youReads = countSettingReads('nav_order_you');

    const first = loadPageOrders();
    expect(loadPageOrders()).toBe(first);
    await Promise.all([first, loadPageOrders()]);
    await loadPageOrders();

    expect(worldReads()).toBe(1);
    expect(youReads()).toBe(0);
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: true, stored: ['country:DE', 'world'] });
  });

  it('with no row it hydrates to no stored order', async () => {
    await loadPageOrders();
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: true, stored: null });
  });

  it('marks hydrated even when the read fails, and does not reject', async () => {
    failSettingRead(WORLD);
    await expect(loadPageOrders()).resolves.toBeUndefined();
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: true, stored: null });
  });
});

describe('setWorldPageOrder', () => {
  it('updates the store at once (deduped), persists the row, and survives a reset and reload', async () => {
    setWorldPageOrder(['country:DE', 'world', 'country:DE']);
    expect(usePageOrderStore.getState().stored).toEqual(['country:DE', 'world']);
    expect(await persisted(WORLD)).toBe('["country:DE","world"]');

    resetPageOrders();
    expect(usePageOrderStore.getState().stored).toBeNull();
    await loadPageOrders();
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: true, stored: ['country:DE', 'world'] });
  });
});

describe('resetPageOrders', () => {
  it('clears the in-memory order and the memo, so the next load reads the row again', async () => {
    await setSetting(WORLD, '["world"]');
    const reads = countSettingReads(WORLD);
    const first = loadPageOrders();
    await first;
    expect(usePageOrderStore.getState().stored).toEqual(['world']);

    resetPageOrders();
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: false, stored: null });

    await setSetting(WORLD, '["country:FR","world"]'); // setSetting reads the key too
    const before = reads();
    await loadPageOrders();
    expect(reads() - before).toBe(1);
    expect(usePageOrderStore.getState().stored).toEqual(['country:FR', 'world']);
  });

  it('a load started before a reset never writes the old account into the store', async () => {
    await setSetting(WORLD, '["country:DE","world"]');
    const held = holdNextSettingResult(WORLD);

    const stale = loadPageOrders();
    resetPageOrders();
    held.release();
    await stale;
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: false, stored: null });

    // The reset also dropped the memo: a new load is a new read and does land.
    await loadPageOrders();
    expect(usePageOrderStore.getState()).toMatchObject({ hydrated: true, stored: ['country:DE', 'world'] });
  });
});
