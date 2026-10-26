// Returning to the app: a short absence changes nothing, a long one (SESSION_RESUME_AFTER_MS = 5 min
// of BACKGROUND) starts a new reading session. Time is a strict fake clock moved with
// `jest.setSystemTime`, so the 5-minute boundary is exact.
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { setAppState } from '@/test/helpers';
import {
  HIGH,
  MEDIUM,
  act,
  arrive,
  hydrateSuggestions,
  persistedCardStates,
  renderFeed,
  resetFeedStores,
  seedComplete,
  settleWrites,
  useStrictClock,
  waitFor,
} from './support';

const FIVE_MIN = 5 * 60_000;

// The in-memory DB schedules its own timers, so every DB step runs on real timers; the strict
// clock is installed only around the absence itself (and is dropped by the harness after the test).
beforeEach(async () => {
  setAppState('active');
  await resetFeedStores();
});

/** Eight rows mounted, r7 viewed (the snapshot is stale), then a HIGH arrival below the pin.
 *  Returns the list as the reader sees it now. */
async function readerMidFeed() {
  await seedComplete(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'].map((id) => [id, MEDIUM] as const));
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toHaveLength(8));
  await act(async () => {});
  act(() => useFeedOrderStore.getState().markViewed('r7'));
  await arrive([['newH', HIGH]]);
  await waitFor(() => expect(feed.ids()).toContain('newH'));
  // Pin of six, the HIGH arrival leads the dynamic region, r7 still counts as unviewed.
  expect(feed.ids()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'newH', 'r7', 'r8']);
  return feed;
}

/** Background, jump `awayMs`, come back. The strict clock must be installed. */
function awayFor(awayMs: number) {
  act(() => setAppState('background'));
  jest.setSystemTime(Date.now() + awayMs);
  act(() => setAppState('active'));
}

describe('background then active', () => {
  it.each([
    ['4 minutes', 4 * 60_000],
    ['1 ms under the threshold', FIVE_MIN - 1],
  ])('after %s nothing moves', async (_label, awayMs) => {
    const feed = await readerMidFeed();
    const before = feed.ids();

    useStrictClock();
    awayFor(awayMs);
    await act(async () => {});

    expect(feed.ids()).toEqual(before);
  });

  it.each([
    ['exactly 5 minutes', FIVE_MIN],
    ['6 minutes', 6 * 60_000],
  ])('after %s the session resets: pin dropped, snapshot refreshed', async (_label, awayMs) => {
    const feed = await readerMidFeed();

    useStrictClock();
    awayFor(awayMs);

    // r7 (viewed) sinks to tier 1; HIGH leads; the old pin no longer holds r1..r6 in place.
    await waitFor(() =>
      expect(feed.ids()).toEqual(['newH', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r8', 'r7']),
    );
  });

  it('only a background stamp counts: an app-switcher "inactive" is not an absence', async () => {
    const feed = await readerMidFeed();
    const before = feed.ids();

    useStrictClock();
    act(() => setAppState('inactive'));
    jest.setSystemTime(Date.now() + 6 * 60_000);
    act(() => setAppState('active'));
    await act(async () => {});

    expect(feed.ids()).toEqual(before);
  });

  it('a second absence is measured from its own background, not the first', async () => {
    const feed = await readerMidFeed();
    useStrictClock();
    awayFor(4 * 60_000);
    jest.setSystemTime(Date.now() + 10 * 60_000); // time spent in the foreground does not add up
    awayFor(4 * 60_000);
    await act(async () => {});
    expect(feed.ids()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'newH', 'r7', 'r8']);
  });
});

describe('going to background', () => {
  it('writes the pending card-state mark at once instead of waiting for the debounce', async () => {
    await seedComplete([['r1', MEDIUM], ['r2', MEDIUM]]);
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toHaveLength(2));

    // The 1 s persist debounce is armed on the frozen clock, so it can never fire: the write
    // below can only come from the background flush.
    useStrictClock();
    act(() => useFeedOrderStore.getState().markViewed('r2'));
    act(() => setAppState('background'));
    jest.useRealTimers();
    await settleWrites();

    expect(await persistedCardStates()).toMatchObject({ r2: ['v', expect.any(Number)] });
  });

  it('"inactive" does not flush', async () => {
    await seedComplete([['r1', MEDIUM], ['r2', MEDIUM]]);
    await hydrateSuggestions();
    const feed = await renderFeed();
    await waitFor(() => expect(feed.ids()).toHaveLength(2));

    useStrictClock();
    act(() => useFeedOrderStore.getState().markViewed('r2'));
    act(() => setAppState('inactive'));
    jest.useRealTimers();
    await settleWrites();

    expect(await persistedCardStates()).toBeNull();
  });
});
