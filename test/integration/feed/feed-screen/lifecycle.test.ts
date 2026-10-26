// The Feed's Continuous view: useFeedScreen driven under renderHook with the real stores, the
// in-memory DB and MSW. Seams: insert-only ingest, the pinned prefix, the partition snapshot,
// pending-note ordering, blur, and the empty-state chain flags.
import { addFact } from '@/lib/database/services/fact-service';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { setAppState, signInFixtureAccount } from '@/test/helpers';
import {
  HIGH,
  LOW,
  MEDIUM,
  act,
  arrive,
  hydrateSuggestions,
  renderFeed,
  resetFeedStores,
  seedComplete,
  seedReasonPending,
  useStrictClock,
  waitFor,
} from './support';

beforeEach(async () => {
  setAppState('active');
  await resetFeedStores();
});

/** Six same-band rows, so only the pin (not relevance) decides where an arrival may land. */
const SIX = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => [id, MEDIUM] as const);
/** Two past the initial pin of six, so a dynamic region exists. */
const EIGHT = [...SIX, ['r7', MEDIUM], ['r8', MEDIUM]] as const;

/** Mount with `rows` stored and wait until the pin has seeded (the list is non-empty and stable). */
async function mountWith(rows: readonly (readonly [string, number])[]) {
  await seedComplete(rows);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toHaveLength(rows.length));
  await act(async () => {});
  return feed;
}

describe('ingest is insert-only', () => {
  it('shows new complete rows and keeps every earlier row across later ingests', async () => {
    const feed = await mountWith([['a', HIGH], ['b', MEDIUM]]);
    expect(feed.ids()).toEqual(['a', 'b']);

    await arrive([['c', LOW]]);
    await waitFor(() => expect(feed.ids()).toContain('c'));
    expect(feed.ids()).toEqual(['a', 'b', 'c']);

    await arrive([['d', HIGH]]);
    await waitFor(() => expect(feed.ids()).toContain('d'));
    expect(feed.ids()).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
    expect(feed.ids()).toHaveLength(4);
  });

  it('a candidate pool that empties out removes nothing from the list or the order', async () => {
    const feed = await mountWith([['a', HIGH], ['b', MEDIUM], ['c', LOW]]);
    const before = feed.ids();

    act(() => useForYouStore.setState({ suggestions: [] }));
    await act(async () => {});

    expect(feed.ids()).toEqual(before);
    expect(useFeedOrderStore.getState().order).toHaveLength(3);
  });

  it('a re-render with nothing new leaves the list untouched', async () => {
    const feed = await mountWith(SIX);
    const before = feed.ids();
    feed.rerender({ focused: true });
    feed.rerender({ focused: true });
    expect(feed.ids()).toEqual(before);
  });
});

describe('pinned prefix', () => {
  it('a higher-relevance arrival lands below the first six rows, not above the reader', async () => {
    const feed = await mountWith(EIGHT);
    const before = feed.ids();

    await arrive([['hot', HIGH]]);
    await waitFor(() => expect(feed.ids()).toContain('hot'));

    // Six pinned (floor of 2, + PIN_SLACK 4), then the arrival leads the dynamic region on band alone.
    expect(feed.ids().slice(0, 6)).toEqual(before.slice(0, 6));
    expect(feed.ids()[6]).toBe('hot');
    expect(feed.ids().slice(7)).toEqual(before.slice(6));
  });

  it('grows to cover the deepest row the reader has seen, plus three cards of slack', async () => {
    const feed = await mountWith(EIGHT);
    const before = feed.ids();

    // The Feed's 75% viewability pair reports the fourth row (index 3) as viewable: 3 + 4 pins seven.
    act(() =>
      feed.result.current.viewabilityConfigCallbackPairs[0].onViewableItemsChanged({
        changed: [{ key: before[3], isViewable: true }],
      } as never),
    );
    await arrive([['hot', HIGH]]);
    await waitFor(() => expect(feed.ids()).toContain('hot'));

    expect(feed.ids().slice(0, 7)).toEqual(before.slice(0, 7));
    expect(feed.ids()[7]).toBe('hot');
  });
});

describe('partition snapshot', () => {
  it('a card marked viewed mid-session does not move until the list is reset', async () => {
    const feed = await mountWith(EIGHT);
    const before = feed.ids();
    const pinnedRow = before[0];
    const dynamicRow = before[6];

    act(() => {
      useFeedOrderStore.getState().markViewed(pinnedRow);
      useFeedOrderStore.getState().markViewed(dynamicRow);
    });
    await act(async () => {});
    expect(feed.ids()).toEqual(before);
  });

  it('pull-to-refresh re-freezes it: viewed cards sink below the unviewed ones', async () => {
    await signInFixtureAccount();
    const feed = await mountWith(EIGHT);
    const before = feed.ids();
    const pinnedRow = before[0];
    const dynamicRow = before[6];

    act(() => {
      useFeedOrderStore.getState().markViewed(pinnedRow);
      useFeedOrderStore.getState().markViewed(dynamicRow);
    });
    act(() => feed.result.current.onRefresh());

    // Unviewed in their old relative order, then the two viewed ones (tier 1) in theirs.
    const unviewed = before.filter((id) => id !== pinnedRow && id !== dynamicRow);
    await waitFor(() => expect(feed.ids()).toEqual([...unviewed, pinnedRow, dynamicRow]));
  });
});

describe('rows whose note is still being written', () => {
  it('a reason_pending row that clears the gate is listed after every unseen LOW row', async () => {
    await seedComplete([['hi', HIGH], ['mid', MEDIUM], ['lo', LOW]]);
    await seedReasonPending('pend-hi', 0.95);
    await seedReasonPending('pend-lo', LOW);
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toHaveLength(5));

    // PENDING_BAND_OFFSET sinks both below the LOW band; relevance order holds among them.
    expect(feed.ids()).toEqual(['hi', 'mid', 'lo', 'pend-hi', 'pend-lo']);
  });
});

describe('leaving the tab', () => {
  it('blur leaves the order alone, even with viewed marks waiting in the store', async () => {
    const feed = await mountWith(SIX);
    const before = feed.ids();
    act(() => useFeedOrderStore.getState().markViewed(before[0]));

    feed.focus(false);
    await act(async () => {});

    expect(feed.ids()).toEqual(before);
  });

  /** Put `id` on screen, bottom edge inside the seen band, the way the list's viewability pair
   *  and a row's `measureInWindow` do. */
  function putOnScreen(feed: Awaited<ReturnType<typeof mountWith>>, id: string) {
    feed.result.current.registerRow(id)({ measureInWindow: (cb: (...a: number[]) => void) => cb(0, 200, 300, 100) } as never);
    act(() =>
      feed.result.current.viewabilityConfigCallbackPairs[1].onViewableItemsChanged({
        changed: [{ key: id, isViewable: true }],
      } as never),
    );
  }

  it('blur flushes a card that dwelt on screen into the store, without re-sorting', async () => {
    const feed = await mountWith(SIX);
    const before = feed.ids();
    useStrictClock();
    putOnScreen(feed, before[1]);
    jest.setSystemTime(Date.now() + 2_000); // past the 1.5 s dwell
    expect(useFeedOrderStore.getState().cardStates[before[1]]).toBeUndefined();

    feed.focus(false);

    expect(useFeedOrderStore.getState().cardStates[before[1]]).toMatchObject({ state: 'skipped' });
    expect(feed.ids()).toEqual(before);
  });

  it('blur marks nothing for a card that has not dwelt long enough', async () => {
    const feed = await mountWith(SIX);
    const before = feed.ids();
    useStrictClock();
    putOnScreen(feed, before[1]);
    jest.setSystemTime(Date.now() + 1_000);

    feed.focus(false);

    expect(useFeedOrderStore.getState().cardStates).toEqual({});
  });

  it('a blurred Feed ingests nothing; the arrival lands when it is focused again', async () => {
    const feed = await mountWith(SIX);
    const before = feed.ids();
    feed.focus(false);

    await arrive([['late', HIGH]]);
    await act(async () => {});
    expect(feed.ids()).toEqual(before);

    feed.focus(true);
    await waitFor(() => expect(feed.ids()).toContain('late'));
    expect(feed.ids().slice(0, 4)).toEqual(before.slice(0, 4));
  });
});

describe('empty-state chain flags', () => {
  it('no facts: noFacts is true and the empty card is not offered', async () => {
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.result.current.noFacts).toBe(true));
    expect(feed.result.current.emptyHere).toBe(false);
  });

  it('facts but no run finished yet: emptyHere stays false', async () => {
    await addFact('I follow Formula 1 racing');
    await hydrateSuggestions();
    const feed = await renderFeed();
    await act(async () => {});
    expect(feed.result.current.noFacts).toBe(false);
    expect(feed.result.current.lastProcessingRunFinishedAt).toBeNull();
    expect(feed.result.current.emptyHere).toBe(false);
  });

  it('facts, a finished run and no rows: emptyHere is true', async () => {
    await addFact('I follow Formula 1 racing');
    await hydrateSuggestions();
    const feed = await renderFeed();
    act(() => useForYouStore.getState().markProcessingRunFinished());
    await waitFor(() => expect(feed.result.current.emptyHere).toBe(true));
    expect(feed.result.current.noFacts).toBe(false);
    expect(feed.result.current.hasRows).toBe(false);
  });
});
