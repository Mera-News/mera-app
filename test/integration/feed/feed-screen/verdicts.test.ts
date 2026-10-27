// The feedback sheet reporting a verdict on a Feed card (feedbackHandlers.onVerdictRecorded):
// the dislike lands in feed-order-store under the list-item id, committed, and the card is
// stamped viewed. The sheet writes the article_feedback row itself (useArticleMenu).
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { setAppState, signInFixtureAccount } from '@/test/helpers';
import { HIGH, LOW, MEDIUM, act, hydrateSuggestions, renderFeed, resetFeedStores, seedComplete, waitFor } from './support';

beforeEach(async () => {
  setAppState('active');
  await resetFeedStores();
  await signInFixtureAccount();
});

async function mount() {
  await seedComplete([['a', HIGH], ['b', MEDIUM], ['c', LOW]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toHaveLength(3));
  const suggestionOf = (id: string) => feed.result.current.listData.find((it) => it.id === id)!.suggestion;
  const record = (id: string) => useFeedOrderStore.getState().verdicts[id];
  const cardState = (id: string) => useFeedOrderStore.getState().cardStates[id]?.state;
  const recorded = (id: string) => act(() => feed.result.current.feedbackHandlers.onVerdictRecorded(suggestionOf(id)));
  return { feed, record, cardState, recorded };
}

describe('a verdict reported by the feedback sheet on a Feed card', () => {
  it('is kept under the list-item id as a committed dislike and stamps the card viewed', async () => {
    const { record, cardState, recorded } = await mount();
    expect(cardState('b')).toBeUndefined();

    recorded('b');

    expect(record('b')).toMatchObject({ verdict: 'dislike', committed: true });
    expect(cardState('b')).toBe('viewed');
  });

  it('a second answer on the same card changes nothing', async () => {
    const { record, recorded } = await mount();
    recorded('b');
    const first = record('b');
    recorded('b');
    expect(record('b')).toEqual(first);
  });

  it('verdicts on two cards do not touch each other', async () => {
    const { record, recorded } = await mount();
    recorded('a');
    recorded('c');

    expect(record('a')?.verdict).toBe('dislike');
    expect(record('c')?.verdict).toBe('dislike');
    expect(record('b')).toBeUndefined();
  });

  it('does not re-sort the list: the viewed card holds its place until a reset', async () => {
    const { feed, recorded } = await mount();
    const before = feed.ids();
    recorded('a');
    await act(async () => {});
    expect(feed.ids()).toEqual(before);
  });
});
