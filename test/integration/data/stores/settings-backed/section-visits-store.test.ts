// Dashboard section visits: one JSON map under one settings key, pruned to a
// 7-day window on hydrate and merged (newer wins) with a markVisited that raced
// ahead of the read. Replaces lib/stores/__tests__/section-visits-store.test.ts
// (which mocked setting-service).
import logger from '@/lib/logger';
import { setSetting } from '@/lib/database/services/setting-service';
import { SECTION_VISIT_RETENTION_MS, useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import { useStrictClock as freezeClockAt } from '@/test/helpers';
import {
  countSettingReads,
  failNextWrite,
  failSettingRead,
  flush,
  persisted,
  resetStore,
  restoreFaults,
} from './support';

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

const KEY = 'section_last_visited_v1';
const NOW = 1_760_000_000_000;
const store = useSectionVisitsStore;
const seed = (visits: unknown) => setSetting(KEY, typeof visits === 'string' ? visits : JSON.stringify(visits));

/** Hydrates with the clock stopped at NOW (strict: time does not leak in), then back to real timers. */
async function hydrateAtNow(): Promise<void> {
  freezeClockAt(NOW);
  try {
    await store.getState().hydrate();
  } finally {
    jest.useRealTimers();
  }
}

beforeEach(() => resetStore(store));
afterEach(() => restoreFaults());

describe('hydrate', () => {
  it('starts empty and unhydrated; no row hydrates to {}', async () => {
    expect(store.getState()).toMatchObject({ visits: {}, hydrated: false });
    await hydrateAtNow();
    expect(store.getState()).toMatchObject({ visits: {}, hydrated: true });
  });

  it('parses the stored map', async () => {
    await seed({ 'fact-1': NOW, 'fact-2': NOW - 1000 });
    await hydrateAtNow();
    expect(store.getState().visits).toEqual({ 'fact-1': NOW, 'fact-2': NOW - 1000 });
  });

  it.each(['{not valid json', '[1,2,3]', '"text"', 'null'])('reads %s as an empty map and still hydrates', async (raw) => {
    await seed(raw);
    await hydrateAtNow();
    expect(store.getState()).toMatchObject({ visits: {}, hydrated: true });
  });

  describe('retention window', () => {
    it('prunes entries older than the window and keeps the rest', async () => {
      await seed({ 'fact-fresh': NOW - 1000, 'fact-stale': NOW - SECTION_VISIT_RETENTION_MS - 1000 });
      await hydrateAtNow();
      expect(store.getState().visits).toEqual({ 'fact-fresh': NOW - 1000 });
    });

    it('keeps an entry exactly at the boundary and prunes one millisecond past it', async () => {
      await seed({
        'fact-boundary': NOW - SECTION_VISIT_RETENTION_MS,
        'fact-past': NOW - SECTION_VISIT_RETENTION_MS - 1,
      });
      await hydrateAtNow();
      expect(store.getState().visits).toEqual({ 'fact-boundary': NOW - SECTION_VISIT_RETENTION_MS });
    });

    it('the window is seven days', () => {
      expect(SECTION_VISIT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  it('a failed read still hydrates and reports', async () => {
    const err = new Error('db crash');
    failSettingRead(KEY, err);
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ visits: {}, hydrated: true });
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'section-visits-store' } }));
  });

  it('concurrent hydrates share one read', async () => {
    await seed({ 'fact-1': Date.now() });
    const reads = countSettingReads(KEY);
    await Promise.all([store.getState().hydrate(), store.getState().hydrate()]);
    expect(reads()).toBe(1);
  });

  describe('merging entries already in memory (a markVisited that got ahead of the read)', () => {
    // State is set directly so the merge is tested apart from what markVisited writes.
    it('keeps the in-memory entry and the stored one', async () => {
      const now = Date.now();
      await seed({ 'fact-from-db': now - 500 });
      store.setState({ visits: { 'fact-optimistic': now } });
      await store.getState().hydrate();
      expect(store.getState().visits).toEqual({ 'fact-optimistic': now, 'fact-from-db': now - 500 });
    });

    it('the stored value wins when it is newer', async () => {
      const now = Date.now();
      await seed({ 'fact-1': now });
      store.setState({ visits: { 'fact-1': now - 10_000 } });
      await store.getState().hydrate();
      expect(store.getState().visits['fact-1']).toBe(now);
    });

    it('the in-memory value wins when it is newer', async () => {
      const now = Date.now();
      await seed({ 'fact-1': now - 10_000 });
      store.setState({ visits: { 'fact-1': now } });
      await store.getState().hydrate();
      expect(store.getState().visits['fact-1']).toBe(now);
    });

    it('an in-memory entry is not pruned by the window (it is a visit just made)', async () => {
      await seed({});
      store.setState({ visits: { 'fact-1': NOW - SECTION_VISIT_RETENTION_MS - 1000 } });
      await hydrateAtNow();
      expect(store.getState().visits).toEqual({ 'fact-1': NOW - SECTION_VISIT_RETENTION_MS - 1000 });
    });
  });

  // DATA-U3-1. A markVisited before hydrate persists the map it holds, which is
  // empty of the stored visits, so the row is overwritten with the new entry
  // alone. Hydrate then reads that row: the stored visits are gone from memory
  // and from disk. (The merge above cannot save them; it only sees what is left.)
  describe('a markVisited before the first hydrate', () => {
    async function visitBeforeHydrate() {
      const now = Date.now();
      await seed({ 'fact-from-db': now - 500 });
      store.getState().markVisited('fact-early', now);
      await persisted(KEY, JSON.stringify({ 'fact-early': now }));
      await store.getState().hydrate();
      return now;
    }

    it('pins today: the stored visits are overwritten by the early entry', async () => {
      const now = await visitBeforeHydrate();
      expect(store.getState().visits).toEqual({ 'fact-early': now });
    });

    test.failing('keeps the stored visits', async () => {
      const now = await visitBeforeHydrate();
      expect(store.getState().visits).toEqual({ 'fact-early': now, 'fact-from-db': now - 500 });
    });
  });
});

describe('markVisited', () => {
  it('stamps the clock when no time is given', async () => {
    freezeClockAt(NOW);
    try {
      store.getState().markVisited('fact-a');
    } finally {
      jest.useRealTimers();
    }
    expect(store.getState().visits['fact-a']).toBe(NOW);
  });

  it('uses the given time, before any hydrate', () => {
    store.getState().markVisited('fact-early', 999);
    expect(store.getState().visits['fact-early']).toBe(999);
    expect(store.getState().hydrated).toBe(false);
  });

  it('persists the whole accumulated map, and it survives a rehydrate', async () => {
    const now = Date.now();
    store.getState().markVisited('fact-1', now - 2000);
    store.getState().markVisited('fact-2', now - 1000);
    const row = JSON.stringify({ 'fact-1': now - 2000, 'fact-2': now - 1000 });
    expect(await persisted(KEY, row)).toBe(row);

    resetStore(store);
    await store.getState().hydrate();
    expect(store.getState().visits).toEqual({ 'fact-1': now - 2000, 'fact-2': now - 1000 });
  });

  it('a failed write is reported and the visit stays in memory', async () => {
    const err = new Error('persist fail');
    failNextWrite(err);
    store.getState().markVisited('fact-d', 1);
    await flush();
    expect(store.getState().visits['fact-d']).toBe(1);
    expect(logger.captureException).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { store: 'section-visits-store' } }));
  });
});
