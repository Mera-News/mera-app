// P6 call site 3 of 3: the RETROACTIVE purge must not undo the headline exemption.
//
// The sweep screens ALL stored rows blindly and marks the matches terminal `excluded` AND evicts
// them from the Feed tab, so a headline the scoring stage deliberately kept would be killed on the
// next "add a filter" sweep and the two halves would fight forever. This also pins the other half
// of P6: the labels. A filtered-but-shown card must say so; the label is derived from the same
// matcher over the same rehydrated rows, so it can never under-label.
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-service';
import { retireSuppression } from '@/lib/database/services/suppression-service';
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import {
  purgeHardFilteredSuggestions,
  refreshHardFilterLabels,
  unexcludeRetiredHardFilters,
} from '@/lib/services/suppression-sweep';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
import { addHardFilter, quietLogger, resetForYouStore, seedArticles, settleWrites, suggestionRows } from './seed';

/** One matching normal row and one matching HEADLINE row. */
const seedBoth = () =>
  seedArticles([
    { id: 'normal', title: 'Nvidia ships a GPU' },
    { id: 'head', title: 'Nvidia ships a GPU', headlineScope: 'GLOBAL' },
  ]);

function seedFeedOrder(ids: string[]): void {
  useFeedOrderStore.setState({
    hydrated: true,
    order: [...ids],
    itemsById: Object.fromEntries(ids.map((id) => [id, { id } as never])),
  });
}

const statuses = async () =>
  Object.fromEntries(Object.entries(await suggestionRows()).map(([id, r]) => [id, r.status]));
const labels = () => useHardFilterLabelStore.getState().labels;

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  __resetSuggestionsRefreshThrottleForTests();
  resetForYouStore();
  useFeedOrderStore.setState({ hydrated: false, order: [], itemsById: {}, builtAt: null });
  useHardFilterLabelStore.getState().clear();
});
afterEach(async () => {
  await settleWrites();
  __resetSuggestionsRefreshThrottleForTests();
  logs.restore();
});

describe('purgeHardFilteredSuggestions: headline rows survive the purge', () => {
  it('marks only the non-headline match excluded', async () => {
    await seedBoth();
    await addHardFilter({ keyword: 'nvidia' });

    const r = await purgeHardFilteredSuggestions(123);

    expect(r.excludedIds).toEqual(['normal']);
    expect(await statuses()).toEqual({ normal: 'excluded', head: 'unscored' });
  });

  it('does NOT evict the headline row from the Feed tab', async () => {
    await seedBoth();
    await addHardFilter({ keyword: 'nvidia' });
    seedFeedOrder(['normal', 'head', 'other']);

    const r = await purgeHardFilteredSuggestions();

    expect(r.evictedFromFeed).toBe(1);
    expect(useFeedOrderStore.getState().order).toEqual(['head', 'other']);
  });

  it('is a full no-op when the ONLY matches are headlines', async () => {
    await seedArticles([{ id: 'head', title: 'Nvidia ships a GPU', headlineScope: 'GLOBAL' }]);
    await addHardFilter({ keyword: 'nvidia' });
    seedFeedOrder(['head']);

    const r = await purgeHardFilteredSuggestions();

    expect(r.excludedIds).toEqual([]);
    expect(await statuses()).toEqual({ head: 'unscored' });
    expect(useFeedOrderStore.getState().order).toEqual(['head']);
  });
});

describe('refreshHardFilterLabels: the card label', () => {
  it('publishes the matching filter for the headline row and nothing for the normal one', async () => {
    await seedBoth();
    await addHardFilter({ keyword: 'nvidia' });

    const published = await refreshHardFilterLabels();

    expect([...published.keys()]).toEqual(['head']);
    expect(published.get('head')).toBe('nvidia');
    expect(labels()).toEqual({ head: 'nvidia' });
  });

  it('labels nothing when there are no hard filters', async () => {
    await seedBoth();

    const published = await refreshHardFilterLabels();

    expect(published.size).toBe(0);
    expect(labels()).toEqual({});
  });

  it('drops a stale label once the filter is retired (no cleanup step needed)', async () => {
    await seedBoth();
    const nvidia = await addHardFilter({ keyword: 'nvidia' });
    await refreshHardFilterLabels();
    expect(labels()).toEqual({ head: 'nvidia' });

    await retireSuppression(nvidia);
    await refreshHardFilterLabels();

    expect(labels()).toEqual({});
  });

  it('labels a headline matched via a STRUCTURED kind the trimmed store row could not see', async () => {
    // `category` never reaches ForYouSuggestion: deriving the label at render time would silently
    // miss this row, which is the surprise P6 exists to end.
    await seedArticles([{ id: 'head', category: 'technology', headlineScope: 'COUNTRY' }]);
    await addHardFilter({ kind: 'category', value: 'technology' });

    const published = await refreshHardFilterLabels();

    expect(published.get('head')).toBe('technology');
  });

  // The label follows exclusion exactly (both go through the same rehydration and screen), so a
  // tag-derived kind that CAN exclude also labels. `place` is used: `entity` cannot exclude, so it
  // cannot label either (next test).
  it('DOES label via a TAG-derived kind', async () => {
    await seedArticles([
      { id: 'head', geoTags: [{ city: 'Taipei', countryCode: 'TWN' }], headlineScope: 'COUNTRY' },
    ]);
    await addHardFilter({ kind: 'place', value: 'taipei' });

    const published = await refreshHardFilterLabels();

    expect(published.get('head')).toBe('taipei');
  });

  it('does NOT label via an entity filter: it never excluded, so there is nothing to explain', async () => {
    // Labelling a card for a filter that did not remove anything would be a claim we cannot stand
    // behind at 68.8% extraction accuracy.
    await seedArticles([{ id: 'head', entities: ['Nvidia'], headlineScope: 'COUNTRY' }]);
    await addHardFilter({ kind: 'entity', value: 'nvidia' });

    const published = await refreshHardFilterLabels();

    expect(published.size).toBe(0);
  });
});

describe('unexcludeRetiredHardFilters: headline rows are never released', () => {
  // A headline row is exempt from hard-filter exclusion, so `excluded` + `headlineScope != null`
  // is unambiguously the LOW-band cull. Releasing it would re-score it, reproduce the LOW verdict
  // and cull it again, an inference-paid churn loop fired by retiring any unrelated filter.
  it('leaves a culled headline excluded even when every filter is retired', async () => {
    await seedBoth();
    await batchMarkExcluded(['normal', 'head']);

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['normal']);
    expect(await statuses()).toEqual({ normal: 'unscored', head: 'excluded' });
  });

  it('leaves it excluded while its filter is still active, too', async () => {
    await seedBoth();
    await addHardFilter({ keyword: 'nvidia' });
    await batchMarkExcluded(['normal', 'head']);

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual([]);
    // Only the non-headline row was screened; the filter still matches it.
    expect(r.stillExcluded).toBe(1);
    expect(await statuses()).toEqual({ normal: 'excluded', head: 'excluded' });
  });
});
