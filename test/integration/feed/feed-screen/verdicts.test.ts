// A thumb on a Feed card, through the hook's own onVerdict: the verdict lands in feed-order-store
// under the list-item id, the card is stamped viewed, and the article_feedback row is exclusive.
import { getArticleVerdict, hasLiked } from '@/lib/database/services/article-feedback-service';
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
  const verdictRow = async (id: string) => (await getArticleVerdict(id)).verdict;
  const record = (id: string) => useFeedOrderStore.getState().verdicts[id];
  const cardState = (id: string) => useFeedOrderStore.getState().cardStates[id]?.state;
  return { feed, suggestionOf, verdictRow, record, cardState };
}

describe('onVerdict on a Feed card', () => {
  it('a like is kept under the list-item id, stamps the card viewed and writes one like row', async () => {
    const { feed, suggestionOf, verdictRow, record, cardState } = await mount();
    expect(cardState('b')).toBeUndefined();

    act(() => feed.result.current.onVerdict(suggestionOf('b'), 'like'));

    expect(record('b')).toMatchObject({ verdict: 'like', path: [] });
    expect(cardState('b')).toBe('viewed');
    await waitFor(async () => expect(await verdictRow('b')).toBe('like'));
  });

  it('a dislike after a like flips it: one verdict, the like row is gone', async () => {
    const { feed, suggestionOf, verdictRow, record } = await mount();
    act(() => feed.result.current.onVerdict(suggestionOf('b'), 'like'));
    await waitFor(async () => expect(await verdictRow('b')).toBe('like'));

    act(() => feed.result.current.onVerdict(suggestionOf('b'), 'dislike'));

    expect(record('b')).toMatchObject({ verdict: 'dislike', path: [] });
    await waitFor(async () => expect(await verdictRow('b')).toBe('dislike'));
    // getArticleVerdict prefers a stray like row, so check it directly too.
    expect(await hasLiked('b')).toBe(false);
  });

  it('the same thumb again clears the verdict and its row, and the card stays viewed', async () => {
    const { feed, suggestionOf, verdictRow, record, cardState } = await mount();
    act(() => feed.result.current.onVerdict(suggestionOf('b'), 'dislike'));
    await waitFor(async () => expect(await verdictRow('b')).toBe('dislike'));

    act(() => feed.result.current.onVerdict(suggestionOf('b'), 'dislike'));

    expect(record('b')).toBeUndefined();
    expect(cardState('b')).toBe('viewed');
    await waitFor(async () => expect(await verdictRow('b')).toBeNull());
  });

  it('verdicts on two cards do not touch each other', async () => {
    const { feed, suggestionOf, verdictRow, record } = await mount();
    act(() => feed.result.current.onVerdict(suggestionOf('a'), 'like'));
    act(() => feed.result.current.onVerdict(suggestionOf('c'), 'dislike'));

    expect(record('a')?.verdict).toBe('like');
    expect(record('c')?.verdict).toBe('dislike');
    expect(record('b')).toBeUndefined();
    await waitFor(async () => {
      expect(await verdictRow('a')).toBe('like');
      expect(await verdictRow('c')).toBe('dislike');
    });
    expect(await verdictRow('b')).toBeNull();
  });

  it('a verdict does not re-sort the list: the viewed card holds its place until a reset', async () => {
    const { feed, suggestionOf } = await mount();
    const before = feed.ids();
    act(() => feed.result.current.onVerdict(suggestionOf('a'), 'like'));
    await act(async () => {});
    expect(feed.ids()).toEqual(before);
  });
});
