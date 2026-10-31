// Nothing on screen moves when picks arrive (owner, MERA-APP-8T), and the Feed shows only what
// Mera has read (owner): a row still waiting for its first read never renders. A new pick lands
// at least one screen of cards past the last card on screen, or at the end of the list. Driven
// through useFeedScreen with the real stores and the list's own viewability pairs.
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { batchMarkScoreFailed } from '@/lib/database/services/article-suggestion-scoring-writes';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { setAppState } from '@/test/helpers';
import {
  HIGH,
  MEDIUM,
  act,
  arrive,
  hydrateSuggestions,
  renderFeed,
  resetFeedStores,
  seedArticles,
  seedComplete,
  waitFor,
} from './support';

beforeEach(async () => {
  setAppState('active');
  await resetFeedStores();
});

type Feed = Awaited<ReturnType<typeof renderFeed>>;

const UNREAD_TITLES = [
  'Ferry strike disrupts the island crossings',
  'Glacier retreat exposes a medieval trade path',
  'Library opens its archive of wartime letters',
  'Tidal power trial doubles its output target',
  'Bakers protest a sudden flour price jump',
  'Museum returns a carved door to its village',
];

async function seedNotRead(ids: readonly string[]) {
  await seedArticles(ids.map((id, i) => ({ id, title: UNREAD_TITLES[i] })));
}

/** Mera tried these rows and the attempt finished with no score (P1.13b's stamp). */
async function markTriedUnscored(ids: readonly string[]) {
  const rows = await loadSuggestions();
  await batchMarkScoreFailed(rows.filter((r) => ids.includes(r.articleId)).map((r) => r._id));
}

/** The list reports these rows on screen (the 1% pair) and all but the last ≥75% visible. */
function onScreen(feed: Feed, ids: readonly string[]) {
  const [anchor, visible] = feed.result.current.viewabilityConfigCallbackPairs;
  act(() => visible.onViewableItemsChanged({ changed: ids.map((key) => ({ key, isViewable: true })) } as never));
  act(() =>
    anchor.onViewableItemsChanged({ changed: ids.slice(0, -1).map((key) => ({ key, isViewable: true })) } as never),
  );
}

/** A pick reaches the phone and the Feed ingests it. */
async function pickArrives(id: string) {
  await arrive([[id, HIGH]]);
  await waitFor(() => expect(useFeedOrderStore.getState().order).toContain(id));
  await act(async () => {});
}

/** Every on-screen row keeps its index, and `arrival` is either not rendered or at least one
 *  screen of cards past the last row on screen. */
function expectNoShift(feed: Feed, before: readonly string[], shown: readonly string[], arrival: string) {
  const after = feed.ids();
  for (const id of shown) expect(after.indexOf(id)).toBe(before.indexOf(id));
  const at = after.indexOf(arrival);
  const lastShown = Math.max(...shown.map((id) => before.indexOf(id)));
  if (at >= 0) expect(at).toBeGreaterThanOrEqual(lastShown + 1 + shown.length);
}

it('a row Mera has not read never renders, and a pick arriving after it lands at the end', async () => {
  await seedComplete([['p1', HIGH], ['p2', HIGH]]);
  await seedNotRead(['u1', 'u2', 'u3', 'u4']);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toEqual(['p1', 'p2']));
  await act(async () => {});
  expect(feed.ids()).toEqual(['p1', 'p2']);

  onScreen(feed, ['p1', 'p2']);
  await pickArrives('hot');

  expect(feed.ids()).toEqual(['p1', 'p2', 'hot']);
});

it('cold start: rows waiting for their first read show nothing, and the first pick appears', async () => {
  await seedNotRead(['u1', 'u2', 'u3', 'u4', 'u5']);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await act(async () => {});
  expect(feed.ids()).toEqual([]);

  await pickArrives('hot');

  await waitFor(() => expect(feed.ids()).toEqual(['hot']));
});

it('short cards: a pick lands a whole screen of cards below the last card on screen', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => [`r${i}`, MEDIUM] as const);
  await seedComplete(rows);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toHaveLength(8));
  const before = feed.ids();

  const shown = before.slice(0, 4);
  onScreen(feed, shown);
  await pickArrives('hot');

  expectNoShift(feed, before, shown, 'hot');
  expect(feed.ids()).toContain('hot');
});

it('a pick may join the end of a short list: nothing on screen moves', async () => {
  await seedComplete([['p1', MEDIUM], ['p2', MEDIUM]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toHaveLength(2));
  const before = feed.ids();

  onScreen(feed, before);
  await pickArrives('hot');

  expect(feed.ids()).toEqual([...before, 'hot']);
});

describe('rows Mera tried and that stayed unscored (score_failed_at)', () => {
  it('render after the picks; a row never tried does not', async () => {
    await seedComplete([['p1', HIGH], ['p2', HIGH]]);
    await seedNotRead(['tried', 'waiting']);
    await markTriedUnscored(['tried']);
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toEqual(['p1', 'p2', 'tried']));
    await act(async () => {});
    expect(feed.ids()).toEqual(['p1', 'p2', 'tried']);
  });

  it('a row stamped after mount joins the end, behind the picks', async () => {
    await seedComplete([['p1', HIGH]]);
    await seedNotRead(['later']);
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toEqual(['p1']));

    await markTriedUnscored(['later']);
    await act(async () => {
      await hydrateSuggestions();
    });

    await waitFor(() => expect(feed.ids()).toEqual(['p1', 'later']));
  });

  it('with tried rows on screen after the picks, an arriving pick moves nothing', async () => {
    await seedComplete([['p1', HIGH], ['p2', HIGH]]);
    await seedNotRead(['t1', 't2', 't3']);
    await markTriedUnscored(['t1', 't2', 't3']);
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toHaveLength(5));
    const before = feed.ids();

    const shown = before.slice(0, 3);
    onScreen(feed, shown);
    await pickArrives('hot');

    // The P2.7 hold: a pick could only land above the tried rows on screen, so it waits.
    expectNoShift(feed, before, shown, 'hot');
    expect(feed.ids()).toEqual(before);
  });
});
