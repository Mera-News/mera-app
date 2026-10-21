// Show: Discarded by Mera, through useFeedScreen with the real stores and the in-memory DB. Seams:
// the discarded list renders alone, never under All, never enters the order store, and the Show
// menu's counts are published live from the same segments.
import {
  setFeedShow,
  setFeedShowMenuOpen,
  resetFeedViewPrefs,
  useFeedShowCountsStore,
} from '@/components/custom/feed/feed-view-prefs';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { setAppState } from '@/test/helpers';
import { HIGH, act, arrive, hydrateSuggestions, renderFeed, resetFeedStores, seedComplete, waitFor } from './support';

beforeEach(async () => {
  setAppState('active');
  resetFeedViewPrefs();
  useFeedShowCountsStore.setState({ counts: null, menuOpen: false });
  await resetFeedStores();
});

const counts = () => useFeedShowCountsStore.getState().counts;

it('All shows the pick only; Discarded by Mera shows the below-gate row alone; the order store never holds it', async () => {
  await seedComplete([['pick', HIGH], ['low', 0.2], ['zero', 0]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toEqual(['pick']));
  // The discarded stories are grouped only while the Show menu is open or the option is on.
  expect(counts()).toEqual({
    all: { n: 1 },
    picks: { n: 1 },
    unread: { n: 0 },
  });
  act(() => setFeedShowMenuOpen(true));
  await waitFor(() =>
    expect(counts()).toEqual({
      all: { n: 1 },
      picks: { n: 1 },
      unread: { n: 0 },
      discarded: { n: 2 },
    }),
  );
  act(() => setFeedShowMenuOpen(false));
  await waitFor(() => expect(counts()?.discarded).toBeUndefined());

  act(() => setFeedShow('discarded'));
  await waitFor(() => expect(feed.ids().sort()).toEqual(['low', 'zero']));
  expect(feed.result.current.picksCount).toBe(0);
  // Its rows can never be marked seen (not in the order), so none wears the new-card halo.
  expect(feed.result.current.newSince).toBeNull();
  expect(useFeedOrderStore.getState().order).toEqual(['pick']);

  // Counts follow the feed live: a new discarded row lands in the list and the count.
  await arrive([['low2', 0.1]]);
  await waitFor(() => expect(counts()?.discarded?.n).toBe(3));
  expect(feed.ids()).toContain('low2');
  expect(useFeedOrderStore.getState().order).not.toContain('low2');

  act(() => setFeedShow('all'));
  await waitFor(() => expect(feed.ids()).toEqual(['pick']));
});

it('the counts are withdrawn when the Continuous list unmounts', async () => {
  await seedComplete([['pick', HIGH]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(counts()?.picks?.n).toBe(1));
  feed.unmount();
  expect(counts()).toBeNull();
});
