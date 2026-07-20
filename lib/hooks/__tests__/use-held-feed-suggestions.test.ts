// use-held-feed-suggestions — focus-aware hold gate. Uses the `focused` override
// (no navigator), fake timers for the blurred coalesce, and a synchronous
// startTransition so adoption timing is deterministic. The watermark store is
// mocked to a spyable `advance`.

// startTransition → synchronous passthrough (see use-focus-coalesced-value.test).
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, startTransition: (fn: () => void) => fn() };
});

const mockAdvance = jest.fn();
jest.mock('@/lib/stores/feed-watermark-store', () => ({
  useFeedWatermarkStore: { getState: () => ({ advance: mockAdvance }) },
}));

// eslint-disable-next-line import/first
import { act, renderHook } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { useHeldFeedSuggestions } from '../use-held-feed-suggestions';
// eslint-disable-next-line import/first
import type { ForYouSuggestion, ClusterMembership } from '@/lib/stores/for-you-store';
// eslint-disable-next-line import/first
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';

const ISO = '2024-01-01T00:00:00.000Z';

function sugg(
  id: string,
  o: Partial<ForYouSuggestion> = {},
): ForYouSuggestion {
  return {
    _id: id,
    articleId: `art-${id}`,
    clusters: [],
    relevance: 0.6,
    reason: '',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: null,
    publication_name: null,
    title_en: id,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: ISO,
    // Recent so the 24h pending window (relative to the fake-timer "now", which
    // is the real current date) keeps held arrivals eligible for the pill.
    firstPubDate: new Date().toISOString(),
    rawScore: 0.6,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...o,
  };
}

function clu(stableClusterId: string): ClusterMembership {
  return { clusterId: `c-${stableClusterId}`, confidence: 0.9, stableClusterId };
}

type Props = { live: ForYouSuggestion[]; focused: boolean };
const setup = (initial: Props) =>
  renderHook(({ live, focused }: Props) => useHeldFeedSuggestions(live, { focused, blurredIntervalMs: 5000 }), {
    initialProps: initial,
  });

const ids = (arr: ForYouSuggestion[]) => arr.map((s) => s._id);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('useHeldFeedSuggestions', () => {
  it('cold start adopts everything — no pill', () => {
    const { result } = setup({ live: [sugg('a'), sugg('b')], focused: true });
    expect(ids(result.current.suggestions)).toEqual(['a', 'b']);
    expect(result.current.pendingNewCount).toBe(0);
  });

  it('focused: HOLDS insertions and surfaces them as pendingNewCount', () => {
    const { result, rerender } = setup({ live: [sugg('a')], focused: true });
    act(() => rerender({ live: [sugg('a'), sugg('c')], focused: true }));
    expect(ids(result.current.suggestions)).toEqual(['a']); // c held
    expect(result.current.pendingNewCount).toBe(1);
  });

  it('focused: cold-start hydration (empty mount → rows land) adopts immediately', () => {
    // Tab mounts before the store hydrates, so first-mount adopt saw []. Rows
    // then land while focused — they must render, not be held as an empty screen.
    const { result, rerender } = setup({ live: [], focused: true });
    expect(ids(result.current.suggestions)).toEqual([]);
    act(() => rerender({ live: [sugg('a'), sugg('b')], focused: true }));
    expect(ids(result.current.suggestions)).toEqual(['a', 'b']);
    expect(result.current.pendingNewCount).toBe(0);
  });

  it('focused: cold-start rows older than 24h still render (were the invisible case)', () => {
    // firstPubDate older than the pending window: previously these were both held
    // AND pill-invisible → a permanently blank feed. Empty-screen adopt fixes it.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { result, rerender } = setup({ live: [], focused: true });
    act(() =>
      rerender({
        live: [sugg('a', { firstPubDate: old }), sugg('b', { firstPubDate: old })],
        focused: true,
      }),
    );
    expect(ids(result.current.suggestions)).toEqual(['a', 'b']);
    expect(result.current.pendingNewCount).toBe(0);
  });

  it('focused: in-place update of an adopted row flows through', () => {
    const { result, rerender } = setup({ live: [sugg('a', { relevance: 0.6 })], focused: true });
    const updated = sugg('a', { relevance: 0.95, reason: 'rescored' });
    act(() => rerender({ live: [updated], focused: true }));
    expect(result.current.suggestions[0]).toBe(updated);
    expect(result.current.suggestions[0].relevance).toBe(0.95);
    expect(result.current.pendingNewCount).toBe(0);
  });

  it('focused: removal of an adopted row flows through', () => {
    const { result, rerender } = setup({ live: [sugg('a'), sugg('b')], focused: true });
    act(() => rerender({ live: [sugg('a')], focused: true }));
    expect(ids(result.current.suggestions)).toEqual(['a']);
  });

  it('pendingNewCount dedups held arrivals by stable cluster id', () => {
    const { result, rerender } = setup({ live: [sugg('a')], focused: true });
    act(() =>
      rerender({
        live: [sugg('a'), sugg('c', { clusters: [clu('S')] }), sugg('d', { clusters: [clu('S')] })],
        focused: true,
      }),
    );
    expect(result.current.pendingNewCount).toBe(1); // c + d share stable cluster S
  });

  it('adoptPending advances the watermark over the outgoing rows and adopts', () => {
    const a = sugg('a', { createdAt: '2024-02-01T00:00:00.000Z' });
    const { result, rerender } = setup({ live: [a], focused: true });
    act(() => rerender({ live: [a, sugg('c')], focused: true }));
    expect(result.current.pendingNewCount).toBe(1);

    let ret = false;
    act(() => {
      ret = result.current.adoptPending();
    });
    expect(ret).toBe(true);
    // Watermark advanced over the OUTGOING rendered rows ([a] only).
    expect(mockAdvance).toHaveBeenCalledWith(Date.parse('2024-02-01T00:00:00.000Z'));
    expect(ids(result.current.suggestions)).toEqual(['a', 'c']);
    expect(result.current.pendingNewCount).toBe(0);
  });

  it('blur adopts live + advances the watermark over the outgoing rows', () => {
    const a = sugg('a', { createdAt: '2024-03-01T00:00:00.000Z' });
    const { result, rerender } = setup({ live: [a], focused: true });
    act(() => rerender({ live: [a, sugg('c')], focused: true })); // c held
    expect(ids(result.current.suggestions)).toEqual(['a']);

    act(() => rerender({ live: [a, sugg('c')], focused: false })); // BLUR edge
    expect(mockAdvance).toHaveBeenCalledWith(Date.parse('2024-03-01T00:00:00.000Z'));
    expect(ids(result.current.suggestions)).toEqual(['a', 'c']);
    expect(result.current.pendingNewCount).toBe(0);
  });

  it('blurred: trailing-coalesces a later insertion after the interval', () => {
    const { result, rerender } = setup({ live: [sugg('a')], focused: true });
    act(() => rerender({ live: [sugg('a')], focused: false })); // blur edge, adopts [a]
    mockAdvance.mockClear();

    act(() => rerender({ live: [sugg('a'), sugg('c')], focused: false })); // blurred insertion
    expect(ids(result.current.suggestions)).toEqual(['a']); // not adopted yet

    act(() => jest.advanceTimersByTime(5000));
    expect(ids(result.current.suggestions)).toEqual(['a', 'c']); // coalesced in
  });

  it('refocus adopts the latest live immediately', () => {
    const { result, rerender } = setup({ live: [sugg('a')], focused: true });
    act(() => rerender({ live: [sugg('a')], focused: false })); // blur
    act(() => rerender({ live: [sugg('a'), sugg('c')], focused: false })); // blurred insertion (timer armed)
    expect(ids(result.current.suggestions)).toEqual(['a']);

    act(() => rerender({ live: [sugg('a'), sugg('c')], focused: true })); // refocus
    expect(ids(result.current.suggestions)).toEqual(['a', 'c']);
    expect(result.current.pendingNewCount).toBe(0);
  });
});
