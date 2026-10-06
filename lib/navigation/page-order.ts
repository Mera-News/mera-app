// Per-tab page order: which sub-page comes first in each bottom tab, and in
// what order the rest follow. The first page of a tab is where that tab opens.
//
// Storage: one `settings` row per tab (`nav_order_<tab>`), a JSON array of
// page ids. Backed up (lib/backup/allowlist.ts): an order is a preference the
// user would be annoyed to set up again.
//
// Reading applies the stored order over the tab's default list: unknown ids
// are dropped (a country page whose country left, an id from a newer build),
// missing ids are appended in default order (a page a newer build added). So
// any stored value, including one restored from another build's backup, reads
// as a valid order and nothing ever needs migrating.
//
// Defaults live HERE, not in components/custom/nav/page-registry.ts: lib must
// not import components, and the registry imports these instead.
//
// Timing: hydrateAllStores() is fire-and-forget, so a tab could open on its
// default first page and then jump. The startup gate (app/logged-in/index.tsx)
// therefore awaits the memoised loadPageOrders(), the same promise the
// hydration entry uses, before it routes.
//
// setting-service is lazy-required: this module is read by the nav shell and
// its component suites, which must not load the SQLite singleton.

import { useMemo } from 'react';
import { create } from 'zustand';
import logger from '@/lib/logger';

export type TabId = 'feed' | 'world' | 'library' | 'you';
export type StaticPageId =
  | 'feed'
  | 'interests'
  | 'stories'
  | 'saved'
  | 'checks'
  | 'visited'
  | 'stats'
  | 'profile'
  | 'settings';
/** A country page in World. The suffix is ISO alpha-2 (`country:DE`). */
export type CountryPageId = `country:${string}`;
export type PageId = StaticPageId | 'world' | CountryPageId;

export type StaticTabId = Exclude<TabId, 'world'>;

/** Default order per tab. World's pages are derived at run time
 *  (lib/explore/world-pages.ts), with `world` first. */
export const DEFAULT_PAGE_ORDER: Readonly<Record<StaticTabId, readonly StaticPageId[]>> = {
  feed: ['feed', 'interests', 'stories'],
  library: ['saved', 'checks', 'visited', 'stats'],
  you: ['profile', 'settings'],
};

export const NAV_ORDER_SETTING_KEYS: Readonly<Record<TabId, string>> = {
  feed: 'nav_order_feed',
  world: 'nav_order_world',
  library: 'nav_order_library',
  you: 'nav_order_you',
};

const TABS: readonly TabId[] = ['feed', 'world', 'library', 'you'];

/** A stored row as a list of ids, or null when absent or malformed. */
export function parsePageOrder(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

/** Stored order over the defaults: unknown ids dropped, duplicates dropped,
 *  missing ids appended in default order. */
export function applyPageOrder<T extends string>(
  stored: readonly string[] | null | undefined,
  defaults: readonly T[],
): T[] {
  const known = new Set<string>(defaults);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of [...(stored ?? []), ...defaults]) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id as T);
  }
  return out;
}

type StoredOrders = Readonly<Record<TabId, readonly string[] | null>>;

const EMPTY: StoredOrders = { feed: null, world: null, library: null, you: null };

interface PageOrderState {
  /** Raw stored rows. Read through `usePageOrder` / `applyPageOrder`. */
  stored: StoredOrders;
  hydrated: boolean;
}

export const usePageOrderStore = create<PageOrderState>()(() => ({
  stored: EMPTY,
  hydrated: false,
}));

function settings(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

let loadPromise: Promise<void> | null = null;
/** Bumped by reset, so a load started for the previous account never writes
 *  into the store after the switch. */
let generation = 0;

/** Read all four rows once. Memoised; never rejects. */
export function loadPageOrders(): Promise<void> {
  if (loadPromise) return loadPromise;
  const started = generation;
  loadPromise = (async () => {
    try {
      const { getSetting } = settings();
      const rows = await Promise.all(TABS.map((tab) => getSetting(NAV_ORDER_SETTING_KEYS[tab])));
      if (started !== generation) return;
      const stored = Object.fromEntries(
        TABS.map((tab, i) => [tab, parsePageOrder(rows[i])]),
      ) as unknown as StoredOrders;
      usePageOrderStore.setState({ stored, hydrated: true });
    } catch (err) {
      logger.captureException(err, { tags: { module: 'page-order', method: 'loadPageOrders' } });
      if (started === generation) usePageOrderStore.setState({ hydrated: true });
    }
  })();
  return loadPromise;
}

/** Save a tab's order (the Arrange overlay's ✓). Optimistic: the store updates
 *  at once and the row is written in the background. */
export function setPageOrder(tab: TabId, ids: readonly string[]): void {
  const next = [...new Set(ids)];
  usePageOrderStore.setState((s) => ({ stored: { ...s.stored, [tab]: next } }));
  settings()
    .setSetting(NAV_ORDER_SETTING_KEYS[tab], JSON.stringify(next))
    .catch((err: unknown) =>
      logger.captureException(err, { tags: { module: 'page-order', method: 'setPageOrder' } }),
    );
}

/** Account switch: the settings rows go with the database, so the memory copy
 *  and the memoised load must go too. Called from clearAllStores(). */
export function resetPageOrders(): void {
  generation += 1;
  loadPromise = null;
  usePageOrderStore.setState({ stored: EMPTY, hydrated: false });
}

/** The ordered pages of a tab with a fixed page set. World uses
 *  `useWorldPages()` (lib/explore/world-pages.ts). */
export function usePageOrder(tab: StaticTabId): StaticPageId[] {
  const stored = usePageOrderStore((s) => s.stored[tab]);
  return useMemo(() => applyPageOrder(stored, DEFAULT_PAGE_ORDER[tab]), [stored, tab]);
}
