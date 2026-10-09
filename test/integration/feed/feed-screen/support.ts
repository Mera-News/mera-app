// Shared setup for the Feed list-lifecycle seam tests (useFeedScreen): seeding through the app's
// own services, store resets, and the hook render. Imported first by every test file here so the
// harness helpers load at file-load time, not inside the first beforeEach.
import { renderHookInScreen } from '@/test/helpers';
import { act, waitFor } from '@testing-library/react-native';
import { useFeedScreen } from '@/components/custom/feed/useFeedScreen';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { loadSuggestions, saveScoringResult } from '@/lib/database/services/article-suggestion-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { FEED_CARD_STATE_SETTING_KEY, useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { resetForYouStore, scoreRow, seedArticles, settleWrites } from '../../core/sync/seed';

// Native edges the shared integration setup does not cover for this hook's module chain:
// gesture-handler (Jest cannot parse it) and reanimated's useComposedEventHandler (absent from
// react-native-reanimated/mock). Ask the harness for shared versions, then drop these.
jest.mock('react-native-gesture-handler', () => ({
  Gesture: {},
  GestureDetector: ({ children }: { children: unknown }) => children,
  GestureHandlerRootView: ({ children }: { children: unknown }) => children,
}));
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  useComposedEventHandler: () => () => {},
}));

export { scoreRow, seedArticles, settleWrites };

/** Relevance values inside each band (bandOf: HIGH >= 0.8, MEDIUM >= 0.6, LOW >= 0.4). */
export const HIGH = 0.9;
export const MEDIUM = 0.7;
export const LOW = 0.45;

/** A distinct headline per id, so story grouping never merges two seeded rows. */
const TITLES = [
  'Parliament approves coastal flood barrier funding',
  'Lithium refinery opens near the northern border',
  'Chess federation reverses its ruling on rapid titles',
  'Volcanic ash grounds regional flights for a second day',
  'Orchestra announces a surprise winter residency',
  'Central bank holds rates as inflation cools',
  'Archaeologists date the harbour wall to the bronze age',
  'Wheat harvest beats the forecast across the plains',
  'Telescope array captures a rare double eclipse',
  'City council votes to pilot a night tram line',
];
let titleCursor = 0;

/** Insert complete rows (`scoreRow`: terminal, no note owed) in the order given. */
export async function seedComplete(rows: readonly (readonly [id: string, relevance: number])[]): Promise<void> {
  await seedArticles(rows.map(([id]) => ({ id, title: TITLES[titleCursor++ % TITLES.length] + ` (${id})` })));
  for (const [id, relevance] of rows) await scoreRow(await localId(id), relevance);
}

/** Insert a scored row whose note is still owed: status `reason_pending`. */
export async function seedReasonPending(id: string, relevance: number): Promise<void> {
  await seedArticles([{ id, title: TITLES[titleCursor++ % TITLES.length] + ` (${id})` }]);
  await saveScoringResult(await localId(id), { relevance, reason: '', reasonSkipped: false });
}

async function localId(articleId: string): Promise<string> {
  const row = (await loadSuggestions()).find((s) => s.articleId === articleId);
  if (!row) throw new Error(`seed: no row for ${articleId}`);
  return row._id;
}

/** Load the stored rows into the For You store, the way hydration does at launch. */
export async function hydrateSuggestions(): Promise<void> {
  await useForYouStore.getState().hydrateSuggestionsFromDb();
}

/** Every store the hook reads, back to a blank, un-hydrated slate. `feed-order-store.reset()` also
 *  cancels a pending card-state persist timer (module state); it leaves `hydrated: true`, which
 *  the explicit setState undoes. */
export async function resetFeedStores(): Promise<void> {
  useFeedOrderStore.getState().reset();
  useFeedOrderStore.setState({ hydrated: false });
  resetForYouStore();
  useForYouStore.setState({ suggestionsHydrated: false });
  useOpenedStoriesStore.setState({ ids: new Set(), articleIds: new Set(), hydrated: false });
  useDatabaseStore.getState().setReady(false);
  await settleWrites();
}

export const header: PageHeaderBinding = {
  scrollHandler: (() => {}) as unknown as PageHeaderBinding['scrollHandler'],
  headerHeight: 100,
  hidden: { value: 0 } as PageHeaderBinding['hidden'],
  reveal: jest.fn(),
};

/** Mount the hook as the app does: DB ready, opened set loaded (the hook's own bootstrap does that
 *  too), suggestions in the store. Resolves once the feed-order store has hydrated. */
export async function renderFeed(isFocused = true) {
  useDatabaseStore.getState().setReady(true);
  await useOpenedStoriesStore.getState().hydrate();
  const view = renderHookInScreen(
    ({ focused }: { focused: boolean }) => useFeedScreen({ isFocused: focused, header }),
    { initialProps: { focused: isFocused } },
  );
  await waitFor(() => expect(useFeedOrderStore.getState().hydrated).toBe(true));
  return {
    ...view,
    ids: () => view.result.current.listData.map((it) => it.id),
    /** Flip the hook's `isFocused` parameter. */
    focus: (focused: boolean) => view.rerender({ focused }),
  };
}

/** The card-state blob the store persists, parsed (null when nothing was written). */
export async function persistedCardStates(): Promise<Record<string, [string, number]> | null> {
  const raw = await getSetting(FEED_CARD_STATE_SETTING_KEY);
  return raw ? JSON.parse(raw).states : null;
}

/** New complete rows reach the For You store, as a sync's hydration does. */
export async function arrive(rows: readonly (readonly [id: string, relevance: number])[]): Promise<void> {
  await seedComplete(rows);
  await act(async () => {
    await hydrateSuggestions();
  });
}

/** A strict fake clock: time moves only when the test says so (`jest.setSystemTime`), never in
 *  step with real time. `useFakeClock` lets real time leak in under load, which an upper-bound
 *  timing assertion cannot tolerate. Call it before seeding: seeded pubDates read `Date.now()`. */
export function useStrictClock(now: number = Date.now()): void {
  jest.useFakeTimers({
    advanceTimers: false,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now,
  });
}

export { act, waitFor };
