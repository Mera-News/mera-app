// The counts card's not-read count is published under every Show filter: the held card's gap
// (and its upgrade) must not vanish because Mera's picks hide the tail.
import { resetFeedViewPrefs, setFeedShow } from '@/components/custom/feed/feed-view-prefs';
import { setNotReadWaiting, useFeedStatusCard } from '@/components/custom/for-you/feed-status-card';
import { setAppState } from '@/test/helpers';
import { HIGH, act, hydrateSuggestions, renderFeed, resetFeedStores, seedArticles, seedComplete, waitFor } from './support';

beforeEach(async () => {
  setAppState('active');
  resetFeedViewPrefs();
  setNotReadWaiting(null);
  await resetFeedStores();
});

const waiting = () => useFeedStatusCard.getState().notReadWaiting;

it('stays a number under Mera\'s picks and Discarded, and is withdrawn on unmount', async () => {
  await seedComplete([['pick', HIGH]]);
  await seedArticles([{ id: 'unread', title: 'Ferry strike disrupts the island crossings' }]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(waiting()).toBe(1));

  act(() => setFeedShow('picks'));
  await waitFor(() => expect(feed.ids()).toEqual(['pick']));
  expect(waiting()).toBe(1);

  act(() => setFeedShow('discarded'));
  await waitFor(() => expect(feed.ids()).not.toContain('pick'));
  expect(waiting()).toBe(1);

  feed.unmount();
  expect(waiting()).toBeNull();
});
