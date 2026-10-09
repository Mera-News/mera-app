// for-you-prefs, related-sort and text-scale stores against the real settings
// table: set, read the row back, drop the memory, hydrate, same value.
// Replaces for-you-prefs-store.test.ts, related-sort-store.test.ts and
// text-scale-store.test.ts (all three mocked setting-service).
import { Dimensions } from 'react-native';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useForYouPrefsStore } from '@/lib/stores/for-you-prefs-store';
import {
  DEFAULT_RELATED_SORT_MODE,
  RELATED_SORT_MODES,
  parseRelatedSortMode,
  useRelatedSortStore,
} from '@/lib/stores/related-sort-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import { failNextWrite, failSettingRead, flush, persisted, resetStore, restoreFaults } from './support';

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

beforeEach(() => {
  resetStore(useForYouPrefsStore);
  resetStore(useRelatedSortStore);
  resetStore(useTextScaleStore);
});
afterEach(() => {
  restoreFaults();
  jest.restoreAllMocks();
});

const reported = (store: string) =>
  expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { store } }));

describe('for-you-prefs-store', () => {
  const KEY = 'for_you_recent_24h_only';
  const store = useForYouPrefsStore;

  it('starts off and unhydrated; hydrate with no row stays off', async () => {
    expect(store.getState()).toMatchObject({ recent24hOnly: false, hydrated: false });
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ recent24hOnly: false, hydrated: true });
  });

  it.each([
    [true, '1'],
    [false, '0'],
  ])('setting %s persists %s and survives a rehydrate', async (value, row) => {
    // Start from the opposite value so the round trip cannot pass on the default.
    if (!value) await setSetting(KEY, '1');
    store.getState().setRecent24hOnly(value);
    expect(store.getState().recent24hOnly).toBe(value);
    // For `false` the seeded '1' is already there: wait for the new value.
    expect(await persisted(KEY, row)).toBe(row);

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ recent24hOnly: value, hydrated: true });
  });

  it('reads any value other than "1" as off', async () => {
    await setSetting(KEY, 'true');
    await store.getState().hydrate();
    expect(store.getState().recent24hOnly).toBe(false);
  });

  it('a failed read leaves the default, still hydrates and reports', async () => {
    const err = new Error('db crash');
    failSettingRead(KEY, err);
    await expect(store.getState().hydrate()).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ recent24hOnly: false, hydrated: true });
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'for-you-prefs-store' } }));
  });

  it('a failed write is reported and keeps the in-memory choice', async () => {
    failNextWrite(new Error('persist fail'));
    store.getState().setRecent24hOnly(true);
    await flush();
    expect(store.getState().recent24hOnly).toBe(true);
    reported('for-you-prefs-store');
    expect(await getSetting(KEY)).toBeNull();
  });
});

describe('related-sort-store', () => {
  const KEY = 'related_articles_sort';
  const store = useRelatedSortStore;

  describe('parseRelatedSortMode', () => {
    it.each(RELATED_SORT_MODES)('accepts the known mode %s', (mode) => {
      expect(parseRelatedSortMode(mode)).toBe(mode);
    });

    it.each([null, undefined, '', 'RELEVANCE', 'random'])('falls back to the default for %p', (raw) => {
      expect(parseRelatedSortMode(raw)).toBe(DEFAULT_RELATED_SORT_MODE);
    });

    it('honours an explicit fallback', () => {
      expect(parseRelatedSortMode('nope', 'newest')).toBe('newest');
    });
  });

  it("defaults to today's ordering, unhydrated; no row hydrates to the default", async () => {
    expect(store.getState()).toMatchObject({ mode: 'relevance', hydrated: false });
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ mode: 'relevance', hydrated: true });
  });

  it.each(['oldest', 'newest'] as const)('setMode(%s) applies at once, persists, and survives a rehydrate', async (mode) => {
    store.getState().setMode(mode);
    expect(store.getState().mode).toBe(mode);
    expect(await persisted(KEY)).toBe(mode);

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ mode, hydrated: true });
  });

  it('ignores an unrecognised stored value', async () => {
    await setSetting(KEY, 'by-vibes');
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ mode: 'relevance', hydrated: true });
  });

  it('a failed read leaves the default, still hydrates and reports', async () => {
    failSettingRead(KEY);
    await store.getState().hydrate();
    reported('related-sort-store');
    expect(store.getState()).toMatchObject({ mode: 'relevance', hydrated: true });
  });

  it('a failed write is reported without losing the in-memory choice', async () => {
    failNextWrite(new Error('disk full'));
    store.getState().setMode('oldest');
    await flush();
    expect(store.getState().mode).toBe('oldest');
    reported('related-sort-store');
  });

  it('reset returns to the default and unhydrated (the clearAllStores path)', async () => {
    await setSetting(KEY, 'newest');
    await store.getState().hydrate();
    expect(store.getState().mode).toBe('newest');
    store.getState().reset();
    expect(store.getState()).toMatchObject({ mode: 'relevance', hydrated: false });
  });
});

describe('text-scale-store', () => {
  const KEY = 'text_scale';
  const store = useTextScaleStore;

  const windowWidth = (width: number) => {
    const real = Dimensions.get.bind(Dimensions);
    jest.spyOn(Dimensions, 'get').mockImplementation(((dim: 'window' | 'screen') =>
      dim === 'window' ? { ...real('window'), width } : real(dim)) as never);
  };

  it('starts at the designed size, unhydrated', () => {
    expect(store.getState()).toMatchObject({ scale: 1, hydrated: false });
  });

  it.each([0.9, 1.15, 1.3] as const)('setScale(%s) applies, persists as text and survives a rehydrate', async (scale) => {
    store.getState().setScale(scale);
    expect(store.getState().scale).toBe(scale);
    expect(await persisted(KEY)).toBe(String(scale));

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ scale, hydrated: true });
  });

  // No row = never chosen: the default is derived from the screen width, and a
  // derived default must never be written back as if the reader had chosen it.
  it('with no row, a wide screen keeps the designed default', async () => {
    windowWidth(750);
    await store.getState().hydrate();
    expect(store.getState().scale).toBe(1);
  });

  it('with no row, a narrow screen derives the compact default and never persists it', async () => {
    windowWidth(360);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ scale: 0.9, hydrated: true });
    await flush();
    expect(await getSetting(KEY)).toBeNull();
  });

  it('a stored value beats the narrow-screen default', async () => {
    windowWidth(360);
    await setSetting(KEY, '1');
    await store.getState().hydrate();
    expect(store.getState().scale).toBe(1);
  });

  it('snaps a stored value that is no longer a step', async () => {
    await setSetting(KEY, '1.22');
    await store.getState().hydrate();
    expect(store.getState().scale).toBe(1.15);
  });

  it('falls back to the default for unparseable stored text', async () => {
    await setSetting(KEY, 'enormous');
    await store.getState().hydrate();
    expect(store.getState().scale).toBe(1);
  });

  it('a failed read leaves the default, still hydrates and reports', async () => {
    failSettingRead(KEY);
    await expect(store.getState().hydrate()).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ scale: 1, hydrated: true });
    reported('text-scale-store');
  });

  it('a failed write is reported without throwing', async () => {
    failNextWrite(new Error('persist fail'));
    store.getState().setScale(0.9);
    await flush();
    expect(store.getState().scale).toBe(0.9);
    reported('text-scale-store');
  });
});
