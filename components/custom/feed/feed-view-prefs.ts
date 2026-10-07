// The Feed's two reading preferences, kept on this phone (settings rows):
//   feed_view     'continuous' | 'sectioned'  the View chip (FinalFeed #3)
//   feed_minimap  'true' | absent             Settings > Display > Minimap
//
// Neither is a counter (invariant 9). Both are backed up with the other
// preferences. `loadFeedViewPrefs` is awaited by the startup gate beside the
// page orders, so the Feed never opens Continuous and then jumps to
// Sectioned. `resetFeedViewPrefs` runs in clearAllStores: the database reset
// takes the rows, not this memory.

import logger from '@/lib/logger';
import { create } from 'zustand';

export type FeedView = 'continuous' | 'sectioned';

export const FEED_VIEW_SETTING_KEY = 'feed_view';
export const FEED_MINIMAP_SETTING_KEY = 'feed_minimap';

interface FeedViewPrefsState {
  view: FeedView;
  minimap: boolean;
}

const DEFAULTS: FeedViewPrefsState = { view: 'continuous', minimap: false };

export const useFeedViewPrefs = create<FeedViewPrefsState>()(() => DEFAULTS);

export const useFeedView = (): FeedView => useFeedViewPrefs((s) => s.view);
export const useFeedMinimap = (): boolean => useFeedViewPrefs((s) => s.minimap);

/** Unknown or absent reads as the default, so an older or newer row is safe. */
export function parseFeedView(raw: string | null | undefined): FeedView {
  return raw === 'sectioned' ? 'sectioned' : 'continuous';
}

function settings(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

let loadPromise: Promise<void> | null = null;
/** Bumped by reset, so a load for the previous account never lands after it. */
let generation = 0;

/** Read both rows once. Memoised; never rejects. */
export function loadFeedViewPrefs(): Promise<void> {
  if (loadPromise) return loadPromise;
  const started = generation;
  loadPromise = (async () => {
    try {
      const { getSetting } = settings();
      const [view, minimap] = await Promise.all([
        getSetting(FEED_VIEW_SETTING_KEY),
        getSetting(FEED_MINIMAP_SETTING_KEY),
      ]);
      if (started !== generation) return;
      useFeedViewPrefs.setState({ view: parseFeedView(view), minimap: minimap === 'true' });
    } catch (err) {
      logger.captureException(err, { tags: { module: 'feed-view-prefs', method: 'load' } });
    }
  })();
  return loadPromise;
}

function write(key: string, value: string): void {
  void settings()
    .setSetting(key, value)
    .catch((err: unknown) => logger.captureException(err, { tags: { module: 'feed-view-prefs', key } }));
}

export function setFeedView(view: FeedView): void {
  useFeedViewPrefs.setState({ view });
  write(FEED_VIEW_SETTING_KEY, view);
}

/** Settings > Display > Minimap. */
export function setFeedMinimap(on: boolean): void {
  useFeedViewPrefs.setState({ minimap: on });
  write(FEED_MINIMAP_SETTING_KEY, on ? 'true' : 'false');
}

/** The fact page's last "Go to Feed": the Feed page, sectioned view. */
export function openSectionedFeed(): void {
  setFeedView('sectioned');
  // Lazy: the startup loader imports this file, and the nav graph pulls the router.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('@/components/custom/nav/navigate-to-page') as typeof import('@/components/custom/nav/navigate-to-page')).navigateToPage('feed');
}

export function resetFeedViewPrefs(): void {
  generation += 1;
  loadPromise = null;
  useFeedViewPrefs.setState(DEFAULTS);
}
