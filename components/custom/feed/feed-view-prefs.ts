// The Feed's reading preferences, kept on this phone (settings rows):
//   feed_view     'continuous' | 'sectioned'  the View chip (FinalFeed #3)
//   feed_minimap  'true' | absent             Settings > Display > Minimap
//   feed_show     'all' | 'picks'             the View chip's Show section
//                 (Continuous only). 'unread' and 'discarded' are never
//                 written: they last until the next cold launch, which opens
//                 on All (owner, R7).
//
// None is a counter (invariant 9). All are backed up with the other
// preferences. `loadFeedViewPrefs` is awaited by the startup gate beside the
// page orders, so the Feed never opens Continuous and then jumps to
// Sectioned. `resetFeedViewPrefs` runs in clearAllStores: the database reset
// takes the rows, not this memory.

import type { FeedShow, FeedShowCount } from '@/components/custom/feed/not-read-tail';
import logger from '@/lib/logger';
import { create } from 'zustand';

export type FeedView = 'continuous' | 'sectioned';
export type { FeedShow };

const FEED_VIEW_SETTING_KEY = 'feed_view';
const FEED_MINIMAP_SETTING_KEY = 'feed_minimap';
const FEED_SHOW_SETTING_KEY = 'feed_show';

interface FeedViewPrefsState {
  view: FeedView;
  minimap: boolean;
  show: FeedShow;
}

const DEFAULTS: FeedViewPrefsState = { view: 'continuous', minimap: false, show: 'all' };

/** Each Show option's name. */
export const FEED_SHOW_LABEL_KEY = {
  all: 'feed.show.all',
  picks: 'feed.show.picks',
  unread: 'feed.show.unread',
  discarded: 'feed.show.discarded',
} as const satisfies Record<FeedShow, string>;

export const useFeedViewPrefs = create<FeedViewPrefsState>()(() => DEFAULTS);

export const useFeedView = (): FeedView => useFeedViewPrefs((s) => s.view);
export const useFeedMinimap = (): boolean => useFeedViewPrefs((s) => s.minimap);
export const useFeedShow = (): FeedShow => useFeedViewPrefs((s) => s.show);

/** Each Show option's card count, published by the mounted Continuous list
 *  for the View chip's menu (null while it is not mounted). Never stored. */
export const useFeedShowCountsStore = create<{ counts: Record<FeedShow, FeedShowCount> | null }>()(() => ({
  counts: null,
}));
export const useFeedShowCounts = (): Record<FeedShow, FeedShowCount> | null => useFeedShowCountsStore((s) => s.counts);

export function setFeedShowCounts(counts: Record<FeedShow, FeedShowCount> | null): void {
  useFeedShowCountsStore.setState({ counts });
}

/** Unknown or absent reads as the default, so an older or newer row is safe. */
function parseFeedView(raw: string | null | undefined): FeedView {
  return raw === 'sectioned' ? 'sectioned' : 'continuous';
}

/** Only 'picks' is kept across launches; anything else opens on All. */
export function parseFeedShow(raw: string | null | undefined): FeedShow {
  return raw === 'picks' ? 'picks' : 'all';
}

function settings(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

let loadPromise: Promise<void> | null = null;
/** Bumped by reset, so a load for the previous account never lands after it. */
let generation = 0;

/** Read the rows once. Memoised; never rejects. */
export function loadFeedViewPrefs(): Promise<void> {
  if (loadPromise) return loadPromise;
  const started = generation;
  loadPromise = (async () => {
    try {
      const { getSetting } = settings();
      const [view, minimap, show] = await Promise.all([
        getSetting(FEED_VIEW_SETTING_KEY),
        getSetting(FEED_MINIMAP_SETTING_KEY),
        getSetting(FEED_SHOW_SETTING_KEY),
      ]);
      if (started !== generation) return;
      useFeedViewPrefs.setState({
        view: parseFeedView(view),
        minimap: minimap === 'true',
        show: parseFeedShow(show),
      });
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

/** The Show section. 'unread' and 'discarded' are written as 'all', so a
 *  cold launch opens on All while 'picks' survives it. */
export function setFeedShow(show: FeedShow): void {
  useFeedViewPrefs.setState({ show });
  write(FEED_SHOW_SETTING_KEY, show === 'picks' ? 'picks' : 'all');
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
