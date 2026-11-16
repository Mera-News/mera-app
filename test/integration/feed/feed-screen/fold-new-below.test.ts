// "New stories below" reads the rendered rows only: a new Low story folded behind the fold card is
// not below the reader, so it is never announced. Its own file because the announcement is latched
// once per process (module state in useFeedScreen).
import { AccessibilityInfo } from 'react-native';
import { resetFeedViewPrefs } from '@/components/custom/feed/feed-view-prefs';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { setAppState } from '@/test/helpers';
import { LOW, MEDIUM, act, arrive, finishRun, hydrateSuggestions, renderFeed, resetFeedStores, seedComplete, waitFor } from './support';

jest.setTimeout(20_000);

beforeEach(async () => {
  setAppState('active');
  resetFeedViewPrefs();
  await resetFeedStores();
});

it('a new folded Low story is not announced; a new rendered pick is', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const said = () => announce.mock.calls.some(([text]) => text === 'feed.newStoriesBelowA11y' || /below/i.test(text));

  await seedComplete([['m0', MEDIUM], ['l0', LOW]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(useFeedOrderStore.getState().order).toEqual(expect.arrayContaining(['m0', 'l0'])));
  await finishRun();
  await waitFor(() => expect(feed.result.current.fold.terminal).toBe('fold'));

  await arrive([['l1', LOW]]);
  await waitFor(() => expect(useFeedOrderStore.getState().order).toContain('l1'));
  await act(async () => {});
  expect(feed.ids()).toEqual(['m0']);
  expect(said()).toBe(false);

  // Positive control: the same scan announces a new pick that renders.
  await arrive([['m1', MEDIUM]]);
  await waitFor(() => expect(feed.ids()).toContain('m1'));
  await waitFor(() => expect(said()).toBe(true));
});
