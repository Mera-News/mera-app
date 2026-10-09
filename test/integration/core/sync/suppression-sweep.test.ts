// suppression-sweep: hard "not interested" filters are RETROACTIVE.
//
// Real persona snapshot, real article_suggestions rows on the in-memory DB, real feed-order and
// For You stores. The delicate part is D12b: eviction from the Feed tab removes EXACTLY the ids the
// sweep marked and nothing inferred (tombstone contagion). On the un-exclude side a row blocked by
// two filters stays excluded until BOTH are gone.
import {
  batchMarkExcluded,
  getStageRowsForScreening,
} from '@/lib/database/services/article-suggestion-service';
import { retireSuppression } from '@/lib/database/services/suppression-service';
import {
  __resetSuggestionsRefreshThrottleForTests,
  refreshSuggestionsInStoreUnsafe,
} from '@/lib/services/SuggestionSyncService';
import { purgeHardFilteredSuggestions, unexcludeRetiredHardFilters } from '@/lib/services/suppression-sweep';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
import { addHardFilter, quietLogger, resetForYouStore, seedArticles, settleWrites, suggestionRows } from './seed';

/** Put ids into the persisted feed order so eviction has something to remove. */
function seedFeedOrder(ids: string[]): void {
  useFeedOrderStore.setState({
    hydrated: true,
    order: [...ids],
    itemsById: Object.fromEntries(ids.map((id) => [id, { id } as never])),
  });
}

const statuses = async () =>
  Object.fromEntries(Object.entries(await suggestionRows()).map(([id, r]) => [id, r.status]));

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

describe('purgeHardFilteredSuggestions', () => {
  it('is a no-op when there are no hard filters (stored rows stay as they were)', async () => {
    await seedArticles([{ id: 'a', title: 'Nvidia ships a GPU' }]);
    seedFeedOrder(['a']);

    const r = await purgeHardFilteredSuggestions();

    expect(r.excludedIds).toEqual([]);
    expect(r.evictedFromFeed).toBe(0);
    expect(await statuses()).toEqual({ a: 'unscored' });
    expect(useFeedOrderStore.getState().order).toEqual(['a']);
  });

  it('rehydrates stored rows and marks only the matches excluded, then refreshes the store', async () => {
    await seedArticles([
      { id: 'a', title: 'Nvidia ships a GPU' },
      { id: 'b', title: 'AMD ships a GPU' },
    ]);
    await addHardFilter({ keyword: 'nvidia' });
    await refreshSuggestionsInStoreUnsafe();
    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'a')?.status).toBe('unscored');

    const r = await purgeHardFilteredSuggestions(123);

    expect(r.excludedIds).toEqual(['a']);
    expect(r.valueById.get('a')).toBe('nvidia');
    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
    // refreshUi ran: the on-screen rows already show the exclusion.
    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'a')?.status).toBe('excluded');
    // batchMarkExcluded zeroes the score and stamps nothing it should not.
    expect((await suggestionRows()).a).toMatchObject({ relevance: 0, reason: '' });
  });

  it('matches structured kinds over the rehydrated JSON columns', async () => {
    // `topic` over matched_topics_json: a STRUCTURED kind matches over a rehydrated JSON column.
    await seedArticles([
      { id: 'a', matchedTopics: [{ topicId: 't1', text: 'Nvidia' }] },
      { id: 'b', matchedTopics: [{ topicId: 't2', text: 'AMD' }] },
    ]);
    await addHardFilter({ kind: 'topic', value: 'nvidia' });

    const r = await purgeHardFilteredSuggestions();

    expect(r.excludedIds).toEqual(['a']);
  });

  // ENTITY NEVER EXCLUDES. The sweep re-screens rows the user ALREADY has, so an entity match would
  // delete stories retroactively on the strength of a 68.8%-accurate tag. The hard/soft split in the
  // persona snapshot files an entity filter under soft suppressions, whatever its strength.
  it('does NOT exclude on an entity-kind filter, however strong', async () => {
    await seedArticles([
      { id: 'a', entities: ['Nvidia'] },
      { id: 'b', entities: ['AMD'] },
    ]);
    await addHardFilter({ kind: 'entity', value: 'nvidia' });

    const r = await purgeHardFilteredSuggestions();

    expect(r.excludedIds).toEqual([]);
    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('DOES match a place-kind filter over the rehydrated geo tags', async () => {
    await seedArticles([
      { id: 'a', geoTags: [{ city: 'Taipei', countryCode: 'TWN' }] },
      { id: 'b', geoTags: [{ city: 'Berlin', countryCode: 'DEU' }] },
    ]);
    await addHardFilter({ kind: 'place', value: 'taipei' });

    const r = await purgeHardFilteredSuggestions();

    expect(r.excludedIds).toEqual(['a']);
  });

  it('evicts EXACTLY the excluded ids from the feed order, nothing inferred', async () => {
    await seedArticles([
      { id: 'a', title: 'Nvidia ships a GPU' },
      { id: 'b', title: 'AMD ships a GPU' },
      { id: 'c', title: 'Unrelated' },
    ]);
    seedFeedOrder(['a', 'b', 'c']);
    await addHardFilter({ keyword: 'nvidia' });

    const r = await purgeHardFilteredSuggestions();

    expect(r.evictedFromFeed).toBe(1);
    expect(useFeedOrderStore.getState().order).toEqual(['b', 'c']);
    expect(Object.keys(useFeedOrderStore.getState().itemsById).sort()).toEqual(['b', 'c']);
  });

  it('leaves no tombstone: a re-ingest of the same id is not blocked', async () => {
    await seedArticles([{ id: 'a', title: 'Nvidia ships a GPU' }]);
    seedFeedOrder(['a']);
    await addHardFilter({ keyword: 'nvidia' });

    await purgeHardFilteredSuggestions();

    expect(useFeedOrderStore.getState().order).toEqual([]);
    // Nothing anywhere in the store remembers 'a'.
    expect(JSON.stringify(useFeedOrderStore.getState())).not.toContain('"a"');
  });
});

describe('unexcludeRetiredHardFilters', () => {
  it('resets rows nothing still matches back to unscored', async () => {
    await seedArticles([{ id: 'a', title: 'Nvidia ships a GPU' }]);
    const nvidia = await addHardFilter({ keyword: 'nvidia' });
    await purgeHardFilteredSuggestions();
    expect(await statuses()).toEqual({ a: 'excluded' });
    await retireSuppression(nvidia); // filter retired

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['a']);
    expect(r.stillExcluded).toBe(0);
    expect(await statuses()).toEqual({ a: 'unscored' });
  });

  it('keeps a row excluded while a SECOND active filter still matches it', async () => {
    await seedArticles([
      { id: 'a', title: 'Nvidia ships a GPU', publication: 'The Verge' },
      { id: 'b', title: 'Nvidia ships another GPU', publication: 'Other' },
    ]);
    const nvidia = await addHardFilter({ keyword: 'nvidia' });
    await addHardFilter({ kind: 'publication', value: 'the verge' });
    await purgeHardFilteredSuggestions();
    expect(await statuses()).toEqual({ a: 'excluded', b: 'excluded' });
    // "nvidia" is retired; the publication mute is still active.
    await retireSuppression(nvidia);

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['b']);
    expect(r.stillExcluded).toBe(1);
    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
  });

  it('does nothing when there is nothing excluded', async () => {
    await seedArticles([{ id: 'a', title: 'Nvidia ships a GPU' }]);

    const r = await unexcludeRetiredHardFilters();

    expect(r).toEqual({ resetIds: [], stillExcluded: 0 });
    expect(await statuses()).toEqual({ a: 'unscored' });
  });

  // HEADLINE GUARD. A headline row is exempt from hard-filter exclusion, so an excluded one is the
  // LOW-band cull. It matches no active filter, which is exactly this sweep's release condition:
  // without the guard, retiring ANY unrelated filter would resurrect every culled headline and
  // start a re-score/re-cull churn loop.
  it('never resurrects a culled headline row', async () => {
    await seedArticles([{ id: 'h', title: 'Country headline', headlineScope: 'COUNTRY' }]);
    await batchMarkExcluded(['h']); // the LOW-band cull
    expect((await getStageRowsForScreening({ excluded: true })).map((r) => r.id)).toEqual(['h']);

    const r = await unexcludeRetiredHardFilters(); // every filter retired

    expect(r.resetIds).toEqual([]);
    expect(await statuses()).toEqual({ h: 'excluded' });
  });

  it('still releases a matching non-headline row alongside a culled headline', async () => {
    await seedArticles([
      { id: 'h', title: 'Country headline', headlineScope: 'GLOBAL' },
      { id: 'a', title: 'Nvidia ships a GPU' },
    ]);
    await batchMarkExcluded(['h', 'a']);

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['a']);
    expect(await statuses()).toEqual({ h: 'excluded', a: 'unscored' });
  });
});
