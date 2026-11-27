// A cold launch with a persisted order and persisted card states: the first layout must be
// built from the seeded partition snapshot, never from the empty one before it. Pinning off the
// empty snapshot froze last session's seen rows on top for the whole first session.
import { setSetting } from '@/lib/database/services/setting-service';
import { FEED_CARD_STATE_SETTING_KEY, FEED_ORDER_SETTING_KEY } from '@/lib/stores/feed-order-store';
import { setAppState } from '@/test/helpers';
import { HIGH, act, hydrateSuggestions, renderFeed, resetFeedStores, seedComplete, waitFor } from './support';

jest.setTimeout(20_000);

beforeEach(async () => {
  setAppState('active');
  await resetFeedStores();
});

it('seen High rows from the last session do not stay pinned on top after a cold launch', async () => {
  await seedComplete([
    ['seen1', HIGH],
    ['seen2', HIGH],
    ['new1', HIGH],
    ['new2', HIGH],
  ]);
  const at = Date.now() - 3600_000;
  // Last session put the seen rows first, and the reader saw them there.
  await setSetting(FEED_ORDER_SETTING_KEY, JSON.stringify({ order: ['seen1', 'seen2', 'new1', 'new2'], builtAt: at }));
  await setSetting(FEED_CARD_STATE_SETTING_KEY, JSON.stringify({ states: { seen1: ['v', at], seen2: ['v', at] } }));
  await hydrateSuggestions();

  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toContain('new1'));
  await act(async () => {});

  expect(feed.ids().slice(0, 2)).toEqual(['new1', 'new2']);
});

it('after a cold launch a card only scrolled past stays in the Feed; a tapped one folds', async () => {
  await seedComplete([
    ['tapped', HIGH],
    ['past1', HIGH],
    ['past2', HIGH],
    ['new1', HIGH],
  ]);
  const at = Date.now() - 3600_000;
  await setSetting(FEED_ORDER_SETTING_KEY, JSON.stringify({ order: ['tapped', 'past1', 'past2', 'new1'], builtAt: at }));
  await setSetting(
    FEED_CARD_STATE_SETTING_KEY,
    JSON.stringify({ states: { tapped: ['v', at], past1: ['s', at], past2: ['s', at] } }),
  );
  await hydrateSuggestions();

  const feed = await renderFeed();
  // Jest hydrates the stores before the first render, so this cannot see the pre-seed
  // flash the seed gate in useFeedScreen prevents; it pins the fold rule on the real screen.
  await waitFor(() => expect(feed.ids().length).toBeGreaterThan(0));
  expect(feed.ids()).not.toContain('tapped');
  await act(async () => {});
  expect(feed.ids()).toEqual(expect.arrayContaining(['new1', 'past1', 'past2']));
  expect(feed.ids()).not.toContain('tapped');
});
