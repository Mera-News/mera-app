// use-feed-counts: the Feed's "analysed / relevant / read" numbers over the real For You store, the
// real opened-stories store and the real per-row render gate. Replaces
// lib/hooks/__tests__/use-feed-counts.test.ts (which mocked both stores).
//
// Every number is the last 24 hours (owner): the feed itself keeps listing rows up to 48h old, the
// counts do not. The hook memoises per minute, so the clock is strict (it moves only when driven).
import { act, renderHook } from '@testing-library/react-native';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import {
  COUNTS_WINDOW_MS,
  computeFeedCounts,
  resetFeedCountsMemoForTest,
  useFeedCounts,
} from '@/lib/hooks/use-feed-counts';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useStrictClock } from '@/test/helpers';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 3_600_000;
const row = (id: string, hoursAgo: number, relevance: number, status: string = ArticleSuggestionStatus.Complete) => ({
  articleId: id,
  status,
  relevance,
  firstPubDate: new Date(NOW - hoursAgo * HOUR).toISOString(),
});

describe('computeFeedCounts', () => {
  it('uses the same 24 hours as the published count', () => {
    expect(COUNTS_WINDOW_MS).toBe(24 * HOUR);
  });

  it('counts only rows published in the last 24 hours', () => {
    const rows = [
      row('a', 1, 0.9),
      row('b', 23.9, 0.1),
      row('c', 24.1, 0.9), // still in the 48h feed, not in the counts
      row('d', 40, 0.9),
      row('e', 2, 0.9, ArticleSuggestionStatus.Unscored),
    ];
    const counts = computeFeedCounts(rows, { nowMs: NOW, openedArticleIds: new Set(['a', 'c']) });
    expect(counts).toEqual({ analysedCount: 2, relevantCount: 1, readCount: 1 });
  });

  it('the render gate is inclusive at 0.4 and a row without an opened set reads zero', () => {
    const counts = computeFeedCounts([row('a', 1, 0.4), row('b', 1, 0.39)], { nowMs: NOW });
    expect(counts).toEqual({ analysedCount: 2, relevantCount: 1, readCount: 0 });
  });

  it('judges a v3-scored row at its own 0.55 gate, not the legacy 0.4', () => {
    const v3 = { ...row('v3', 1, 0.5), scoredWithV3: true };
    const counts = computeFeedCounts([v3, row('legacy', 1, 0.5)], { nowMs: NOW });
    expect(counts.relevantCount).toBe(1);
  });
});

describe('useFeedCounts', () => {
  const asStore = (rows: ReturnType<typeof row>[]) => rows as unknown as ForYouSuggestion[];

  beforeEach(() => {
    resetFeedCountsMemoForTest();
    useStrictClock(NOW + 30_000); // 30 s into the minute
    useOpenedStoriesStore.setState({ ids: new Set(), articleIds: new Set(), hydrated: true });
  });

  afterEach(() => {
    useForYouStore.setState({ suggestions: [], articleCount: 0 });
    useOpenedStoriesStore.setState({ ids: new Set(), articleIds: new Set() });
  });

  it('quotes the server article count and derives the other three from the store', () => {
    useForYouStore.setState({
      articleCount: 42,
      suggestions: asStore([row('a', 1, 0.9), row('b', 2, 0.1), row('c', 30, 0.9)]),
    });
    useOpenedStoriesStore.setState({ articleIds: new Set(['a']) });

    const { result } = renderHook(() => useFeedCounts());

    expect(result.current).toEqual({ articleCount: 42, analysedCount: 2, relevantCount: 1, readCount: 1 });
  });

  it('raises the read count the moment a story is opened, never past the relevant count', () => {
    useForYouStore.setState({
      articleCount: 5,
      suggestions: asStore([row('a', 1, 0.9), row('low', 1, 0.1)]),
    });
    const { result } = renderHook(() => useFeedCounts());
    expect(result.current.readCount).toBe(0);

    act(() => useOpenedStoriesStore.getState().markOpened('a'));
    expect(result.current.readCount).toBe(1);

    // Opened but never offered as relevant: not read.
    act(() => useOpenedStoriesStore.getState().markOpened('low'));
    expect(result.current).toMatchObject({ relevantCount: 1, readCount: 1 });
  });

  it('follows new suggestions in the store', () => {
    const { result } = renderHook(() => useFeedCounts());
    expect(result.current).toEqual({ articleCount: 0, analysedCount: 0, relevantCount: 0, readCount: 0 });

    act(() => useForYouStore.setState({ articleCount: 3, suggestions: asStore([row('a', 1, 0.9)]) }));

    expect(result.current).toEqual({ articleCount: 3, analysedCount: 1, relevantCount: 1, readCount: 0 });
  });

  it('drops a row out of the 24h window when the minute rolls over, and not before', async () => {
    // 23h 59m 45s old at render (30 s past the minute): its edge crosses 24h at +15 s.
    // The window is measured from the minute floor, so it leaves at the next minute, not at +15 s.
    useForYouStore.setState({
      articleCount: 1,
      suggestions: asStore([{ ...row('edge', 24, 0.9), firstPubDate: new Date(NOW - 24 * HOUR + 20_000).toISOString() }]),
    });
    const { result } = renderHook(() => useFeedCounts());
    expect(result.current.analysedCount).toBe(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000); // 50 s into the minute: same minute, same window
    });
    expect(result.current.analysedCount).toBe(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000); // next minute: floor moves past the row's 24h mark
    });
    expect(result.current.analysedCount).toBe(0);
  });

  it('stops polling the minute when the last instance unmounts', () => {
    const a = renderHook(() => useFeedCounts());
    const b = renderHook(() => useFeedCounts());
    expect(jest.getTimerCount()).toBe(1); // one shared interval, not one per instance
    a.unmount();
    expect(jest.getTimerCount()).toBe(1);
    b.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('two instances in the same minute agree', () => {
    useForYouStore.setState({ articleCount: 9, suggestions: asStore([row('a', 1, 0.9)]) });
    const a = renderHook(() => useFeedCounts());
    const b = renderHook(() => useFeedCounts());
    expect(a.result.current).toEqual(b.result.current);
  });
});
