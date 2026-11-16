// The 7-day keep on the Feed (D7, D14, D21): an unread High or Emergency story stays past the 48h
// window until 7 days after publish; a read one (viewed on the Feed or opened) and every Medium or
// Low row keep 48h. "Read" comes from the persisted card state and the opened set, so the list must
// be built once both have loaded, not from the empty state before hydrate.
import { setSetting } from '@/lib/database/services/setting-service';
import { FEED_CARD_STATE_SETTING_KEY } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { setAppState } from '@/test/helpers';
import { HIGH, MEDIUM, hydrateSuggestions, renderFeed, resetFeedStores, seedComplete, waitFor } from './support';

jest.setTimeout(20_000);

beforeEach(async () => {
  setAppState('active');
  await resetFeedStores();
});

const DAY = 24 * 3600_000;

/** Publish dates in the For You store, as a sync's re-read would carry them. */
function publishedAgo(ms: Record<string, number>) {
  useForYouStore.setState((s) => ({
    suggestions: s.suggestions.map((x) =>
      ms[x.articleId] === undefined ? x : { ...x, firstPubDate: new Date(Date.now() - ms[x.articleId]).toISOString() },
    ),
  }));
}

it('an unread High at 3 days shows; a viewed High and a Medium at 3 days do not; a High at 8 days does not', async () => {
  await seedComplete([
    ['fresh', HIGH],
    ['unread-high', HIGH],
    ['viewed-high', HIGH],
    ['old-medium', MEDIUM],
    ['too-old', HIGH],
  ]);
  await setSetting(FEED_CARD_STATE_SETTING_KEY, JSON.stringify({ states: { 'viewed-high': ['v', Date.now() - DAY] } }));
  await hydrateSuggestions();
  publishedAgo({ 'unread-high': 3 * DAY, 'viewed-high': 3 * DAY, 'old-medium': 3 * DAY, 'too-old': 8 * DAY });

  const feed = await renderFeed();

  await waitFor(() => expect(feed.ids()).toEqual(expect.arrayContaining(['fresh', 'unread-high'])));
  expect(feed.ids()).not.toContain('viewed-high');
  expect(feed.ids()).not.toContain('old-medium');
  expect(feed.ids()).not.toContain('too-old');
});
