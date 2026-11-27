// The fold (D5, D18): Medium and up above it, Low under "Good to know" after the first run, nothing
// on screen moves when picks arrive. Driven through useFeedScreen with the real stores, the in-memory DB and the list's own
// viewability pairs.
import { FEED_SYNC_TASK } from '@/components/custom/FeedSyncIndicator';
import {
  resetFeedViewPrefs,
  setFeedAlgo,
  setFeedMinimap,
  setFeedShow,
  useFeedShowCountsStore,
} from '@/components/custom/feed/feed-view-prefs';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { batchMarkScoreFailed } from '@/lib/database/services/article-suggestion-scoring-writes';
import { upsertLocation } from '@/lib/database/services/location-service';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { setAppState, signInFixtureAccount } from '@/test/helpers';
import {
  HIGH,
  LOW,
  MEDIUM,
  act,
  arrive,
  finishRun,
  hydrateSuggestions,
  renderFeed,
  resetFeedStores,
  scoreRow,
  seedArticles,
  seedComplete,
  seedReasonPending,
  useStrictClock,
  waitFor,
} from './support';

jest.setTimeout(20_000);

beforeEach(async () => {
  setAppState('active');
  resetFeedViewPrefs();
  useFeedShowCountsStore.setState({ counts: null, menuOpen: false });
  useSchedulerStore.setState({ taskCurrentStatus: {}, taskLastRun: {} });
  useNetworkStore.setState({ isConnected: true });
  await resetFeedStores();
  useForYouStore.setState({ asyncJobProcessedCount: 0, asyncJobTotalCount: 0, batchProgress: null });
});

type Feed = Awaited<ReturnType<typeof renderFeed>>;

async function mountWith(rows: readonly (readonly [string, number])[], extra: () => Promise<void> = async () => {}) {
  await seedComplete(rows);
  await extra();
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(useFeedOrderStore.getState().order).toEqual(expect.arrayContaining(rows.map(([id]) => id))));
  await act(async () => {});
  return feed;
}

/** Rows Mera tried and left unscored: the not-read tail. */
async function seedTried(ids: readonly string[]) {
  await seedArticles(ids.map((id) => ({ id, title: `Ferry timetable changes on route ${id}` })));
  const rows = await loadSuggestions();
  await batchMarkScoreFailed(rows.filter((r) => ids.includes(r.articleId)).map((r) => r._id));
}

/** The list reports these rows on screen (the 1% pair) and all but the last ≥75% visible. */
async function onScreen(feed: Feed, ids: readonly string[]) {
  const [anchor, visible] = feed.result.current.viewabilityConfigCallbackPairs;
  await act(() => visible.onViewableItemsChanged({ changed: ids.map((key) => ({ key, isViewable: true })) } as never));
  await act(() =>
    anchor.onViewableItemsChanged({ changed: ids.slice(0, -1).map((key) => ({ key, isViewable: true })) } as never),
  );
}

async function pickArrives(id: string, relevance = HIGH) {
  await arrive([[id, relevance]]);
  await waitFor(() => expect(useFeedOrderStore.getState().order).toContain(id));
  await act(async () => {});
}

const fold = (feed: Feed) => feed.result.current.fold;

/** Rewrite rows in the For You store, as a sync's re-read would. */
async function patchRows(patch: Record<string, Partial<ForYouSuggestion>>) {
  await act(() =>
    useForYouStore.setState((s) => ({
      suggestions: s.suggestions.map((x) => (patch[x.articleId] ? { ...x, ...patch[x.articleId] } : x)),
    })),
  );
}

describe('the fold line', () => {
  it('before the first run finishes: Low hidden, the quiet reading line; then Low under its label, the tail, the end card', async () => {
    const feed = await mountWith([['h', HIGH], ['m', MEDIUM], ['l1', LOW], ['l2', LOW]], () => seedTried(['t1']));
    expect(feed.ids()).toEqual(['h', 'm']);
    expect(fold(feed).terminal).toBe('reading');

    await finishRun();

    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    expect(feed.ids()).toEqual(['h', 'm', 'l1', 'l2', 't1']);
    expect(fold(feed)).toMatchObject({ index: 2, held: 0 });
    // The not-read divider follows every scored row.
    expect(feed.result.current.picksCount).toBe(4);
  });

  it('seen High and Medium stay above it, an unread High at 30h sits above a fresh Medium', async () => {
    const realNow = Date.now();
    const old = jest.spyOn(Date, 'now').mockReturnValue(realNow - 28 * 3600_000);
    try {
      await seedComplete([['oldH', HIGH]]);
    } finally {
      old.mockRestore();
    }
    const feed = await mountWith([['m', MEDIUM], ['l', LOW]]);
    await finishRun();
    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    expect(feed.ids()).toEqual(['oldH', 'm', 'l']);
    expect(fold(feed).index).toBe(2);
  });

  it('nothing reaching Medium: the label sits over the first row', async () => {
    const feed = await mountWith([['l1', LOW], ['l2', LOW]]);
    await finishRun();
    await waitFor(() => expect(feed.ids()).toEqual(['l1', 'l2']));
    expect(fold(feed).index).toBe(0);
  });

  it('a pending note sinks to the end of its own side of the fold', async () => {
    await seedReasonPending('pm', MEDIUM);
    await seedReasonPending('pl', LOW);
    const feed = await mountWith([['h', HIGH], ['m', MEDIUM], ['l', LOW]]);
    await finishRun();
    await waitFor(() => expect(feed.ids()).toEqual(['h', 'm', 'pm', 'l', 'pl']));
  });
});

describe('seen stories behind the fold (the Feed algorithm default)', () => {
  /** Mount, view `seen`, and start a new session so the snapshot sees it. */
  async function mountSeen(rows: readonly (readonly [string, number])[], seen: string) {
    await signInFixtureAccount();
    const feed = await mountWith(rows);
    await act(() => useFeedOrderStore.getState().markViewed(seen));
    await act(() => feed.result.current.onRefresh());
    await finishRun();
    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    return feed;
  }

  it('only seen rows below it: the seen label takes the fold slot', async () => {
    const feed = await mountSeen([['h1', HIGH], ['h2', HIGH]], 'h2');
    expect(feed.ids()).toEqual(['h1', 'h2']);
    expect(fold(feed)).toMatchObject({ index: 1, seenIndex: 1 });
  });

  it('mixed: unseen Low first, then the seen rows under their own label', async () => {
    const feed = await mountSeen([['h1', HIGH], ['h2', HIGH], ['l', LOW]], 'h2');
    expect(feed.ids()).toEqual(['h1', 'l', 'h2']);
    expect(fold(feed)).toMatchObject({ index: 1, seenIndex: 2 });
  });

  it('with seen stories kept in the main list, a seen High stays above the fold', async () => {
    setFeedAlgo({ seenBelowFold: false });
    const feed = await mountSeen([['h1', HIGH], ['h2', HIGH], ['l', LOW]], 'h2');
    expect(feed.ids()).toEqual(['h1', 'h2', 'l']);
    expect(fold(feed)).toMatchObject({ index: 2, seenIndex: null });
  });
});

describe('fold readiness', () => {
  afterEach(() => jest.useRealTimers());

  it('offline and idle for 3 s: ready without a run', async () => {
    const feed = await mountWith([['h', HIGH], ['l', LOW]]);
    useStrictClock();
    jest.setSystemTime(Date.now() + 3_100);
    expect(fold(feed).terminal).toBe('reading');

    await act(() => useNetworkStore.setState({ isConnected: false }));

    expect(fold(feed).terminal).toBe('end');
  });

  it('a sync that fails, then 3 s of quiet: ready', async () => {
    const feed = await mountWith([['h', HIGH], ['l', LOW]]);
    useStrictClock();
    await act(() => useSchedulerStore.setState({ taskCurrentStatus: { [FEED_SYNC_TASK]: 'running' } }));
    await act(() => useSchedulerStore.setState({ taskCurrentStatus: { [FEED_SYNC_TASK]: 'failed' } }));
    expect(fold(feed).terminal).toBe('reading');

    await act(async () => {
      jest.advanceTimersByTime(3_100);
    });

    expect(fold(feed).terminal).toBe('end');
  });

  it('a scoring run in progress keeps it waiting for the run to finish', async () => {
    const feed = await mountWith([['h', HIGH], ['l', LOW]]);
    useStrictClock();
    await act(() => useForYouStore.setState({ asyncJobProcessedCount: 1, asyncJobTotalCount: 4 }));
    await act(() => useNetworkStore.setState({ isConnected: false }));
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(fold(feed).terminal).toBe('reading');

    await finishRun();
    expect(fold(feed).terminal).toBe('end');
  });
});

describe('the session boundary', () => {
  it('a refresh hides Low again until its first run is done', async () => {
    await signInFixtureAccount();
    const feed = await mountWith([['h', HIGH], ['l', LOW]]);
    await finishRun();
    await waitFor(() => expect(feed.ids()).toEqual(['h', 'l']));

    await act(() => feed.result.current.onRefresh());
    expect(feed.ids()).toEqual(['h']);
    await finishRun();

    await waitFor(() => expect(feed.ids()).toEqual(['h', 'l']));
    expect(fold(feed).index).toBe(1);
  });
});

describe('arrivals with the fold', () => {
  it('Low rows on screen: a High arrival is held, nothing rendered moves, the held line counts it', async () => {
    const feed = await mountWith([['h1', HIGH], ['h2', HIGH], ['l1', LOW], ['l2', LOW]]);
    await finishRun();
    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    await onScreen(feed, ['h1', 'h2', 'l1', 'l2']);

    await pickArrives('hot');
    await pickArrives('late-low', LOW);

    expect(feed.ids()).toEqual(['h1', 'h2', 'l1', 'l2']);
    expect(fold(feed)).toMatchObject({ index: 2, held: 2 });
  });

  it('fold more than a screen below: a High arrival sorts in above it, past the pin', async () => {
    // Nine rows at most: the seed titles repeat after ten, and a repeat groups with its twin.
    const rows = Array.from({ length: 7 }, (_, i) => [`r${i}`, MEDIUM] as const);
    const feed = await mountWith([...rows, ['l1', LOW]]);
    await finishRun();
    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    const before = feed.ids();
    await onScreen(feed, before.slice(0, 2));

    await pickArrives('hot');

    expect(feed.ids().slice(0, 6)).toEqual(before.slice(0, 6));
    expect(feed.ids()[6]).toBe('hot');
    expect(feed.ids()[7]).toBe(before[6]);
    expect(feed.ids()[8]).toBe('l1');
    expect(fold(feed)).toMatchObject({ index: 8, held: 0 });
  });

  it('a note landing moves nothing above the reader', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => [`r${i}`, MEDIUM] as const);
    await seedReasonPending('pend', HIGH);
    const feed = await mountWith(rows);
    await finishRun();
    await waitFor(() => expect(feed.ids()).toHaveLength(9));
    const before = feed.ids();
    expect(before[8]).toBe('pend');
    await onScreen(feed, before.slice(0, 3));

    const pendRow = (await loadSuggestions()).find((s) => s.articleId === 'pend')!;
    await act(async () => {
      await scoreRow(pendRow._id, HIGH);
      await hydrateSuggestions();
    });
    await act(async () => {});

    expect(feed.ids().slice(0, 6)).toEqual(before.slice(0, 6));
  });
});

describe('Show filter, minimap and counts with the fold', () => {
  afterEach(() => setFeedShow('all'));

  it("Mera's picks shows Low under its label too, with no tail", async () => {
    await act(() => setFeedMinimap(true));
    const feed = await mountWith([['h', HIGH], ['m', MEDIUM], ['l', LOW]], () => seedTried(['t1']));
    await act(() => setFeedShow('picks'));
    await finishRun();
    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    expect(feed.ids()).toEqual(['h', 'm', 'l']);
    expect(feed.result.current.minimapRows.map((r) => r.id)).toEqual(['h', 'm', 'l']);
    await act(() => setFeedMinimap(false));
  });

  it('the Show menu counts what each option renders', async () => {
    const feed = await mountWith([['h', HIGH], ['l', LOW]], () => seedTried(['t1']));
    await finishRun();
    await waitFor(() => expect(fold(feed).terminal).toBe('end'));
    const counts = () => useFeedShowCountsStore.getState().counts;
    await waitFor(() => expect(counts()).toMatchObject({ all: { n: 3 }, picks: { n: 2 }, unread: { n: 1 } }));
  });
});

describe('story election and the session boundary', () => {
  it('a story elects its highest-band member to front it', async () => {
    await seedComplete([['med-old', MEDIUM], ['high-new', HIGH]]);
    await hydrateSuggestions();
    await patchRows({
      'med-old': { storyKey: 'sk-same', firstPubDate: new Date(Date.now() - 5 * 3600_000).toISOString() },
      'high-new': { storyKey: 'sk-same' },
    });
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toEqual(['high-new']));
  });

  it('two rows that the server now groups as one story render as one card after a reset', async () => {
    await signInFixtureAccount();
    const feed = await mountWith([['a', HIGH], ['b', HIGH]]);
    expect(feed.ids()).toHaveLength(2);

    await patchRows({ a: { storyKey: 'sk-merged' }, b: { storyKey: 'sk-merged' } });
    await act(async () => {});
    expect(feed.ids()).toHaveLength(2);

    await act(() => feed.result.current.onRefresh());

    await waitFor(() => expect(feed.ids()).toHaveLength(1));
    expect(useFeedOrderStore.getState().order).toHaveLength(1);
  });

  it('a row whose representative switched survives the reset under its old id, viewed state kept', async () => {
    await signInFixtureAccount();
    const feed = await mountWith([['a', MEDIUM]]);
    await act(() => useFeedOrderStore.getState().markViewed('a'));

    // A blurred Feed ingests nothing, so the High copy first reaches the order as a's story.
    await feed.focus(false);
    await arrive([['h', HIGH]]);
    await patchRows({ a: { storyKey: 'sk-grown' }, h: { storyKey: 'sk-grown' } });
    await feed.focus(true);
    await waitFor(() => expect(useFeedOrderStore.getState().itemsById.a?.suggestion.articleId).toBe('h'));

    await act(() => feed.result.current.onRefresh());
    await act(async () => {});

    expect(useFeedOrderStore.getState().order).toEqual(['a']);
    expect(useFeedOrderStore.getState().cardStates.a?.state).toBe('viewed');
  });
});

describe('empty-state chain with places', () => {
  it('no facts but a place: not the no-facts state', async () => {
    await upsertLocation({ city: 'Porto', countryCode: 'PT', role: 'home', weight: 1 });
    await hydrateSuggestions();
    const feed = await renderFeed();
    // Both observers answer within a few ticks; without the place this reads true (lifecycle.test).
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(feed.result.current.noFacts).toBe(false);
  });
});
