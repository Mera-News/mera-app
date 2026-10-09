// The launch-tab preference: lib/navigation/startup-tab.ts (read straight from
// the settings row, before any hydration) and startup-tab-store (the Display
// screen's picker). Replaces lib/navigation/__tests__/startup-tab.test.ts and
// lib/stores/__tests__/startup-tab-store.test.ts (both mocked setting-service).
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { STARTUP_TAB_SETTING_KEY, parseStartupTab, readStartupTab } from '@/lib/navigation/startup-tab';
import { useStartupTabStore } from '@/lib/stores/startup-tab-store';
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

const KEY = STARTUP_TAB_SETTING_KEY;
const store = useStartupTabStore;

beforeEach(() => resetStore(store));
afterEach(() => restoreFaults());

describe('parseStartupTab', () => {
  it.each(['feed', 'world', 'library'] as const)('accepts %s as-is', (tab) => {
    expect(parseStartupTab(tab)).toBe(tab);
  });

  // Older builds stored the old route names. Translated on read, never rewritten.
  it.each([
    ['for_you', 'feed'],
    ['around', 'world'],
  ] as const)('maps the pre-navx route %s to %s', (stored, tab) => {
    expect(parseStartupTab(stored)).toBe(tab);
  });

  it.each([null, undefined, '', 'dashboard', 'you', 'bogus'])('falls back to feed for %p', (raw) => {
    // 'dashboard' is the user-facing label, 'you' a tab that is not an open-on-launch option.
    expect(parseStartupTab(raw)).toBe('feed');
  });
});

describe('readStartupTab (the cold-start router, before hydration)', () => {
  it.each([
    ['feed', 'feed'],
    ['world', 'world'],
    ['library', 'library'],
    ['for_you', 'feed'],
    ['around', 'world'],
  ])('stored %s opens the %s tab, with the store still unhydrated', async (stored, route) => {
    await setSetting(KEY, stored);
    expect(store.getState().hydrated).toBe(false);
    await expect(readStartupTab()).resolves.toBe(route);
  });

  it('defaults to feed when nothing is stored', async () => {
    await expect(readStartupTab()).resolves.toBe('feed');
  });

  it('fails safe to feed when the read throws', async () => {
    await setSetting(KEY, 'library');
    failSettingRead(KEY);
    await expect(readStartupTab()).resolves.toBe('feed');
  });

  it.each(['around', 'for_you'])('reads the old name %s without rewriting the row', async (old) => {
    await setSetting(KEY, old);
    await readStartupTab();
    await flush();
    expect(await getSetting(KEY)).toBe(old);
  });
});

describe('useStartupTabStore', () => {
  it('starts at the default (feed), unhydrated', () => {
    expect(store.getState()).toMatchObject({ startupTab: 'feed', hydrated: false });
  });

  it.each(['library', 'world'] as const)('setStartupTab(%s) applies at once, persists, and survives a rehydrate', async (tab) => {
    store.getState().setStartupTab(tab);
    expect(store.getState().startupTab).toBe(tab);
    expect(await persisted(KEY)).toBe(tab);

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ startupTab: tab, hydrated: true });
    // The router reads the same row the picker wrote.
    await expect(readStartupTab()).resolves.toBe(tab);
  });

  it('translates an old stored route name on hydrate and leaves the row as it was', async () => {
    await setSetting(KEY, 'around');
    await store.getState().hydrate();
    expect(store.getState().startupTab).toBe('world');
    await flush();
    expect(await getSetting(KEY)).toBe('around');
  });

  it('falls back to the default on no row', async () => {
    store.setState({ startupTab: 'world' });
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ startupTab: 'feed', hydrated: true });
  });

  it('falls back to the default on a garbage or removed value', async () => {
    await setSetting(KEY, 'bogus');
    await store.getState().hydrate();
    expect(store.getState().startupTab).toBe('feed');
  });

  it('a failed read leaves the default, still hydrates and reports', async () => {
    const err = new Error('db crash');
    failSettingRead(KEY, err);
    await expect(store.getState().hydrate()).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ startupTab: 'feed', hydrated: true });
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'startup-tab-store' } }));
  });

  it('a failed write is reported without reverting the choice', async () => {
    const err = new Error('persist fail');
    failNextWrite(err);
    store.getState().setStartupTab('world');
    await flush();
    expect(store.getState().startupTab).toBe('world');
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'startup-tab-store' } }));
  });

  it('reset returns to the default, unhydrated (clearAllStores relies on this)', () => {
    store.setState({ startupTab: 'world', hydrated: true });
    store.getState().reset();
    expect(store.getState()).toMatchObject({ startupTab: 'feed', hydrated: false });
  });
});
