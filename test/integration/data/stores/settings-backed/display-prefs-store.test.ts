// Lite mode and the Mera button look in the display-prefs store: the device
// default, the reader's override and look (device-level AsyncStorage), and the
// one-time carry-over of the old "Static background" settings row.
// Replaces display-prefs-store.test.ts (which mocked setting-service).
import AsyncStorage from '@react-native-async-storage/async-storage';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { PERFORMANCE_OVERRIDE_KEY } from '@/lib/performance/performance-mode';
import { MERA_BUTTON_LOOK_KEY, useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { failSettingRead, flush, resetStore, restoreFaults, until } from './support';

// `null` is expo-device's "could not determine" and must not read as a weak phone.
let mockTotalMemory: number | null = null;
jest.mock('expo-device', () => ({
  isDevice: true,
  osVersion: '18.0',
  get totalMemory() {
    return mockTotalMemory;
  },
}));

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

const GB = 1024 * 1024 * 1024;
const LEGACY_KEY = 'static_gradient';
const store = useDisplayPrefsStore;
const stored = (key: string) => AsyncStorage.getItem(key);

beforeEach(() => {
  mockTotalMemory = null;
  resetStore(store);
});
afterEach(() => {
  restoreFaults();
  jest.restoreAllMocks();
});

describe('device default when the reader never chose', () => {
  it('runs Lite on a 4 GB phone', async () => {
    mockTotalMemory = 4 * GB;
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ deviceMode: 'lite', liteMode: true, hydrated: true });
  });

  it('treats exactly 6 GB as Full', async () => {
    mockTotalMemory = 6 * GB;
    await store.getState().hydrate();
    expect(store.getState().liteMode).toBe(false);
  });

  it('keeps Full when memory is unknown', async () => {
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ deviceMode: 'full', liteMode: false });
  });
});

describe('the reader override (AsyncStorage)', () => {
  it('an explicit "full" keeps a 4 GB phone animated', async () => {
    mockTotalMemory = 4 * GB;
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, 'full');
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ performanceOverride: 'full', liteMode: false });
  });

  it('an explicit "lite" applies on an 8 GB phone', async () => {
    mockTotalMemory = 8 * GB;
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, 'lite');
    await store.getState().hydrate();
    expect(store.getState().liteMode).toBe(true);
  });

  it('an unrecognised stored value counts as no choice', async () => {
    mockTotalMemory = 4 * GB;
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, 'turbo');
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ performanceOverride: 'auto', liteMode: true });
    expect(await stored(PERFORMANCE_OVERRIDE_KEY)).toBe('auto');
  });

  it('setPerformanceOverride flips liteMode at once, persists, and survives a rehydrate', async () => {
    mockTotalMemory = 8 * GB;
    await store.getState().hydrate();
    expect(store.getState().liteMode).toBe(false);

    store.getState().setPerformanceOverride('lite');
    expect(store.getState()).toMatchObject({ performanceOverride: 'lite', liteMode: true });
    await until(async () => (await stored(PERFORMANCE_OVERRIDE_KEY)) === 'lite', 'override written');

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ performanceOverride: 'lite', liteMode: true, hydrated: true });
  });

  it('"auto" follows the device', async () => {
    mockTotalMemory = 4 * GB;
    await store.getState().hydrate();
    store.getState().setPerformanceOverride('full');
    expect(store.getState().liteMode).toBe(false);
    store.getState().setPerformanceOverride('auto');
    expect(store.getState().liteMode).toBe(true);
  });

  it('a failing storage read still hydrates, reports, and keeps the device default', async () => {
    mockTotalMemory = 4 * GB;
    const err = new Error('disk');
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(err);
    await expect(store.getState().hydrate()).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ hydrated: true, liteMode: true });
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'display-prefs-store' } }));
  });

  it('a failing override write is reported and keeps the choice in memory', async () => {
    const err = new Error('disk full');
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(err);
    store.getState().setPerformanceOverride('lite');
    await flush();
    expect(store.getState().performanceOverride).toBe('lite');
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'display-prefs-store' } }));
  });
});

describe('the Mera button look', () => {
  it('follows the theme (null) until chosen', async () => {
    await store.getState().hydrate();
    expect(store.getState().meraButtonLook).toBeNull();
  });

  it.each(['light', 'dark'] as const)('%s is set at once, stored on the device, and survives a rehydrate', async (look) => {
    store.getState().setMeraButtonLook(look);
    expect(store.getState().meraButtonLook).toBe(look);
    await until(async () => (await stored(MERA_BUTTON_LOOK_KEY)) === look, 'look written');

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState().meraButtonLook).toBe(look);
  });

  it('ignores a stored value that is not light or dark', async () => {
    await AsyncStorage.setItem(MERA_BUTTON_LOOK_KEY, 'neon');
    await store.getState().hydrate();
    expect(store.getState().meraButtonLook).toBeNull();
  });

  it('an unreadable look keeps the theme', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => {
      if (key === MERA_BUTTON_LOOK_KEY) throw new Error('disk');
      return null;
    });
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ meraButtonLook: null, hydrated: true });
  });

  it('a failing write is reported and keeps the look in memory', async () => {
    const err = new Error('disk full');
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(err);
    store.getState().setMeraButtonLook('dark');
    await flush();
    expect(store.getState().meraButtonLook).toBe('dark');
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'display-prefs-store' } }));
  });
});

describe('carrying the old "Static background" settings row over', () => {
  it('"1" becomes Lite on an 8 GB phone, is stored on the device, and the row is deleted', async () => {
    mockTotalMemory = 8 * GB;
    await setSetting(LEGACY_KEY, '1');
    await store.getState().hydrate();
    expect(await stored(PERFORMANCE_OVERRIDE_KEY)).toBe('lite');
    expect(await getSetting(LEGACY_KEY)).toBeNull();
    expect(store.getState()).toMatchObject({ performanceOverride: 'lite', liteMode: true });
  });

  it('"0" becomes Full on a 4 GB phone and the row is deleted', async () => {
    mockTotalMemory = 4 * GB;
    await setSetting(LEGACY_KEY, '0');
    await store.getState().hydrate();
    expect(await stored(PERFORMANCE_OVERRIDE_KEY)).toBe('full');
    expect(await getSetting(LEGACY_KEY)).toBeNull();
    expect(store.getState().liteMode).toBe(false);
  });

  it('no old row means auto', async () => {
    await store.getState().hydrate();
    expect(await stored(PERFORMANCE_OVERRIDE_KEY)).toBe('auto');
    expect(await getSetting(LEGACY_KEY)).toBeNull();
  });

  it('is read once: with an override already stored the old row is left alone', async () => {
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, 'auto');
    await setSetting(LEGACY_KEY, '1');
    await store.getState().hydrate();
    expect(store.getState().performanceOverride).toBe('auto');
    expect(await getSetting(LEGACY_KEY)).toBe('1');
  });

  it('an unreadable old row counts as no choice', async () => {
    failSettingRead(LEGACY_KEY);
    await store.getState().hydrate();
    expect(await stored(PERFORMANCE_OVERRIDE_KEY)).toBe('auto');
    expect(store.getState().hydrated).toBe(true);
  });
});
