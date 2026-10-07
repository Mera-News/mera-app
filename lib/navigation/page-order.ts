// Page order. Only World is arranged (owner): its order is one `settings` row,
// `nav_order_world`, a JSON array of page ids, backed up as a preference.
// Feed, Library and You have fixed pages in DEFAULT_PAGE_ORDER; any stored
// `nav_order_<tab>` row from an older build is never read again.
//
// Reading applies the stored order over the default list: unknown ids are
// dropped (a country page whose country left, an id from a newer build),
// missing ids are appended in default order. So any stored value, including
// one restored from another build's backup, reads as a valid order and nothing
// ever needs migrating.
//
// Defaults live HERE, not in components/custom/nav/page-registry.ts: lib must
// not import components, and the registry imports these instead.
//
// Timing: hydrateAllStores() is fire-and-forget, so World could open on its
// default first page and then jump. The startup gate (app/logged-in/index.tsx)
// therefore awaits the memoised loadPageOrders(), the same promise the
// hydration entry uses, before it routes.
//
// setting-service is lazy-required: this module is read by the nav shell and
// its component suites, which must not load the SQLite singleton.

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
  | 'settings'
  | 'notifications';
/** A country page in World. The suffix is ISO alpha-2 (`country:DE`). */
export type CountryPageId = `country:${string}`;
export type PageId = StaticPageId | 'world' | CountryPageId;

export type StaticTabId = Exclude<TabId, 'world'>;

/** The fixed page order of every tab but World. World's pages are derived at
 *  run time (lib/explore/world-pages.ts), with `world` first. */
export const DEFAULT_PAGE_ORDER: Readonly<Record<StaticTabId, readonly StaticPageId[]>> = {
  feed: ['feed', 'interests', 'stories'],
  library: ['saved', 'checks', 'visited', 'stats'],
  you: ['profile', 'settings', 'notifications'],
};

export const WORLD_ORDER_SETTING_KEY = 'nav_order_world';

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

interface PageOrderState {
  /** World's raw stored row. Read through `applyPageOrder`. */
  stored: readonly string[] | null;
  hydrated: boolean;
}

export const usePageOrderStore = create<PageOrderState>()(() => ({
  stored: null,
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

/** Read World's row once. Memoised; never rejects. */
export function loadPageOrders(): Promise<void> {
  if (loadPromise) return loadPromise;
  const started = generation;
  loadPromise = (async () => {
    try {
      const row = await settings().getSetting(WORLD_ORDER_SETTING_KEY);
      if (started !== generation) return;
      usePageOrderStore.setState({ stored: parsePageOrder(row), hydrated: true });
    } catch (err) {
      logger.captureException(err, { tags: { module: 'page-order', method: 'loadPageOrders' } });
      if (started === generation) usePageOrderStore.setState({ hydrated: true });
    }
  })();
  return loadPromise;
}

/** Save World's order (the Arrange overlay's ✓). Optimistic: the store
 *  updates at once and the row is written in the background. */
export function setWorldPageOrder(ids: readonly string[]): void {
  const next = [...new Set(ids)];
  usePageOrderStore.setState({ stored: next });
  settings()
    .setSetting(WORLD_ORDER_SETTING_KEY, JSON.stringify(next))
    .catch((err: unknown) =>
      logger.captureException(err, { tags: { module: 'page-order', method: 'setWorldPageOrder' } }),
    );
}

/** Account switch: the settings rows go with the database, so the memory copy
 *  and the memoised load must go too. Called from clearAllStores(). */
export function resetPageOrders(): void {
  generation += 1;
  loadPromise = null;
  usePageOrderStore.setState({ stored: null, hydrated: false });
}

/** The fixed pages of a tab other than World (`useWorldPages()` there). */
export function usePageOrder(tab: StaticTabId): readonly StaticPageId[] {
  return DEFAULT_PAGE_ORDER[tab];
}
