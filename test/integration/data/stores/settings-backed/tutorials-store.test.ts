// Tutorial completion over the settings KV: one row per finished chapter plus a
// menu-seen flag, hydrated by ONE prefix (Q.like) query. Replaces
// lib/stores/__tests__/tutorials-store.test.ts (which mocked setting-service).
import database from '@/lib/database';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  TUTORIAL_SETTING_PREFIX,
  chapterCompletedKey,
  chapterIdFromKey,
  useTutorialsStore,
} from '@/lib/stores/tutorials-store';
import { failNextWrite, failPrefixRead, flush, persisted, resetStore, restoreFaults } from './support';

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

const store = useTutorialsStore;

beforeEach(() => resetStore(store));
afterEach(() => {
  restoreFaults();
  jest.restoreAllMocks();
});

describe('tutorial setting keys', () => {
  it('round-trips a chapter id through its settings key', () => {
    const key = chapterCompletedKey('welcome');
    expect(key).toBe('tutorial_chapter_welcome_completed');
    expect(chapterIdFromKey(key)).toBe('welcome');
  });

  it('survives a slug containing the separator', () => {
    expect(chapterIdFromKey(chapterCompletedKey('deep_dive'))).toBe('deep_dive');
  });

  it('rejects rows that are not chapter completions', () => {
    expect(chapterIdFromKey(`${TUTORIAL_SETTING_PREFIX}menu_seen`)).toBeNull();
    expect(chapterIdFromKey('related_articles_sort')).toBeNull();
    expect(chapterIdFromKey('tutorial_chapter__completed')).toBeNull();
  });
});

describe('useTutorialsStore', () => {
  it('starts empty and unhydrated', () => {
    expect(store.getState()).toMatchObject({ menuSeen: false, hydrated: false });
    expect(store.getState().completed.size).toBe(0);
  });

  it('hydrates every chapter row through the prefix query and ignores other rows', async () => {
    await setSetting('tutorial_chapter_welcome_completed', 'true');
    await setSetting('tutorial_chapter_privacy_completed', 'true');
    await setSetting('tutorial_menu_seen', 'true');
    await setSetting('text_scale', '1.3');

    await store.getState().hydrate();

    const state = store.getState();
    expect([...state.completed].sort()).toEqual(['privacy', 'welcome']);
    expect(state.menuSeen).toBe(true);
    expect(state.hydrated).toBe(true);
  });

  it('ignores rows whose value is not exactly true, and tutorial rows that are not chapters', async () => {
    await setSetting('tutorial_chapter_welcome_completed', 'false');
    await setSetting('tutorial_chapter_feed_completed', '');
    await setSetting('tutorial_something_else', 'true');
    await setSetting('tutorial_menu_seen', 'yes');

    await store.getState().hydrate();

    expect(store.getState().completed.size).toBe(0);
    expect(store.getState().menuSeen).toBe(false);
  });

  it('a failed read still flips hydrated and reports', async () => {
    const err = new Error('db closed');
    failPrefixRead(err);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ hydrated: true, menuSeen: false });
    expect(store.getState().completed.size).toBe(0);
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'tutorials-store' } }));
  });

  it('markCompleted updates at once, persists the row, and survives a rehydrate', async () => {
    store.getState().markCompleted('feed');
    // Optimistic: the tick is there before any write could have landed.
    expect(store.getState().completed.has('feed')).toBe(true);
    expect(await persisted('tutorial_chapter_feed_completed')).toBe('true');

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState().completed.has('feed')).toBe(true);
  });

  it('does not write twice for the same chapter', async () => {
    const write = jest.spyOn(database, 'write');
    store.getState().markCompleted('feed');
    store.getState().markCompleted('feed');
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a failed persist is reported and the tick stays', async () => {
    const err = new Error('write failed');
    failNextWrite(err);
    store.getState().markCompleted('privacy');
    await flush();
    expect(store.getState().completed.has('privacy')).toBe(true);
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'tutorials-store' } }));
    expect(await getSetting('tutorial_chapter_privacy_completed')).toBeNull();
  });

  it('markMenuSeen updates at once, writes once, and survives a rehydrate', async () => {
    const write = jest.spyOn(database, 'write');
    store.getState().markMenuSeen();
    expect(store.getState().menuSeen).toBe(true);
    store.getState().markMenuSeen();
    expect(await persisted('tutorial_menu_seen')).toBe('true');
    await flush();
    expect(write).toHaveBeenCalledTimes(1);

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState().menuSeen).toBe(true);
  });

  it('reset clears progress and un-hydrates', () => {
    store.getState().markCompleted('feed');
    store.setState({ hydrated: true });
    store.getState().reset();
    expect(store.getState()).toMatchObject({ menuSeen: false, hydrated: false });
    expect(store.getState().completed.size).toBe(0);
  });
});
