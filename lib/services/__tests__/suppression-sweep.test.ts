// suppression-sweep — the RETROACTIVE half of hard "not interested" filters.
//
// The delicate part is D12b: eviction from the Feed tab must remove EXACTLY the
// ids the sweep marked and nothing inferred (an earlier wave's general eviction
// caused tombstone contagion). These tests pin that, plus the two-filter case
// on the un-exclude side — a row blocked by two filters must stay excluded
// until BOTH are gone.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

const mockLoadPersona = jest.fn();
const mockGetStageRows = jest.fn();
const mockBatchMarkExcluded = jest.fn().mockResolvedValue(undefined);
const mockBatchResetToUnscored = jest.fn().mockResolvedValue(undefined);
const mockRefreshStore = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  loadPersonaScoringContext: (...a: unknown[]) => mockLoadPersona(...a),
}));
// Readers + writers are stubbed, but `buildStageCandidateInput` stays REAL —
// rehydrating the stored scorer columns is precisely what is under test.
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  ...jest.requireActual('@/lib/database/services/article-suggestion-service'),
  batchMarkExcluded: (...a: unknown[]) => mockBatchMarkExcluded(...a),
  batchResetToUnscored: (...a: unknown[]) => mockBatchResetToUnscored(...a),
  getStageRowsForScreening: (...a: unknown[]) => mockGetStageRows(...a),
}));
jest.mock('../SuggestionSyncService', () => ({
  refreshSuggestionsInStoreUnsafe: () => mockRefreshStore(),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), captureException: jest.fn() },
}));

import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import {
  purgeHardFilteredSuggestions,
  unexcludeRetiredHardFilters,
} from '../suppression-sweep';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';

const row = (id: string, over: Partial<StageCandidateRow> = {}): StageCandidateRow => ({
  id,
  titleEn: null,
  descriptionEn: null,
  publicationName: null,
  countryCode: null,
  firstPubDateMs: null,
  maxClusterSize: null,
  eventType: null,
  category: null,
  geoTagsJson: null,
  entitiesJson: null,
  matchedTopicsJson: null,
  headlineScope: null,
  stableClusterId: null,
  ...over,
});

const persona = (hard: { keywords: string[]; strength: number; kind?: string; value?: string }[]) => ({
  persona: {
    locations: [],
    pubPrefs: new Map(),
    softSuppressions: [],
    hardSuppressions: hard,
  },
  topicWeights: new Map(),
});

/** Put ids into the persisted feed order so eviction has something to remove. */
function seedFeedOrder(ids: string[]): void {
  useFeedOrderStore.setState({
    hydrated: true,
    order: [...ids],
    itemsById: Object.fromEntries(ids.map((id) => [id, { id } as never])),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useFeedOrderStore.setState({ hydrated: false, order: [], itemsById: {}, builtAt: null });
});

describe('purgeHardFilteredSuggestions', () => {
  it('is a no-op when there are no hard filters (never touches stored rows)', async () => {
    mockLoadPersona.mockResolvedValue(persona([]));
    const r = await purgeHardFilteredSuggestions();
    expect(r.excludedIds).toEqual([]);
    expect(mockGetStageRows).not.toHaveBeenCalled();
    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
  });

  it('rehydrates stored rows and marks only the matches excluded', async () => {
    mockLoadPersona.mockResolvedValue(persona([{ keywords: ['nvidia'], strength: 1 }]));
    mockGetStageRows.mockResolvedValue([
      row('a', { titleEn: 'Nvidia ships a GPU' }),
      row('b', { titleEn: 'AMD ships a GPU' }),
    ]);

    const r = await purgeHardFilteredSuggestions(123);

    expect(r.excludedIds).toEqual(['a']);
    expect(r.valueById.get('a')).toBe('nvidia');
    expect(mockBatchMarkExcluded).toHaveBeenCalledWith(['a'], 123);
    expect(mockRefreshStore).toHaveBeenCalledTimes(1);
  });

  it('matches structured kinds over the rehydrated JSON columns', async () => {
    // Uses `topic`/matched_topics_json: pins that a STRUCTURED kind matches over
    // a rehydrated JSON column. The tag-derived kinds get their own test below.
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'topic', value: 'nvidia' }]),
    );
    mockGetStageRows.mockResolvedValue([
      row('a', { matchedTopicsJson: JSON.stringify([{ topicId: 't1', text: 'Nvidia' }]) }),
      row('b', { matchedTopicsJson: JSON.stringify([{ topicId: 't2', text: 'AMD' }]) }),
    ]);

    const r = await purgeHardFilteredSuggestions();
    expect(r.excludedIds).toEqual(['a']);
  });

  // ENTITY NEVER EXCLUDES — and this sweep is why that matters most. It
  // re-screens rows the user ALREADY has, so an entity match here would delete
  // stories retroactively on the strength of a 68.8%-accurate tag. The owner's
  // ruling: entities may nudge a rank, never remove a row.
  //
  // (This assertion has been reversed twice. It first read "does NOT match,
  // because USE_ARTICLE_TAGS blanks the column"; that flag was deleted because
  // it was breaking `place`/`event_type` filters too. Now the column is visible
  // and `entity` alone is excluded from the screen — a narrower rule aimed at
  // the actual accuracy problem rather than at all three kinds.)
  it('does NOT exclude on an entity-kind filter, however strong', async () => {
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'entity', value: 'nvidia' }]),
    );
    mockGetStageRows.mockResolvedValue([
      row('a', { entitiesJson: JSON.stringify(['Nvidia']) }),
      row('b', { entitiesJson: JSON.stringify(['AMD']) }),
    ]);

    const r = await purgeHardFilteredSuggestions();
    expect(r.excludedIds).toEqual([]);
    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
  });

  it('DOES match a place-kind filter over the rehydrated geo tags', async () => {
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'place', value: 'taipei' }]),
    );
    mockGetStageRows.mockResolvedValue([
      row('a', { geoTagsJson: JSON.stringify([{ city: 'Taipei', countryCode: 'TWN' }]) }),
      row('b', { geoTagsJson: JSON.stringify([{ city: 'Berlin', countryCode: 'DEU' }]) }),
    ]);

    const r = await purgeHardFilteredSuggestions();
    expect(r.excludedIds).toEqual(['a']);
  });

  it('evicts EXACTLY the excluded ids from the feed order — nothing inferred', async () => {
    seedFeedOrder(['a', 'b', 'c']);
    mockLoadPersona.mockResolvedValue(persona([{ keywords: ['nvidia'], strength: 1 }]));
    mockGetStageRows.mockResolvedValue([
      row('a', { titleEn: 'Nvidia ships a GPU' }),
      row('b', { titleEn: 'AMD ships a GPU' }),
      row('c', { titleEn: 'Unrelated' }),
    ]);

    const r = await purgeHardFilteredSuggestions();

    expect(r.evictedFromFeed).toBe(1);
    expect(useFeedOrderStore.getState().order).toEqual(['b', 'c']);
    expect(Object.keys(useFeedOrderStore.getState().itemsById).sort()).toEqual(['b', 'c']);
  });

  it('leaves no tombstone — a re-ingest of the same id is not blocked', async () => {
    seedFeedOrder(['a']);
    mockLoadPersona.mockResolvedValue(persona([{ keywords: ['nvidia'], strength: 1 }]));
    mockGetStageRows.mockResolvedValue([row('a', { titleEn: 'Nvidia ships a GPU' })]);
    await purgeHardFilteredSuggestions();
    expect(useFeedOrderStore.getState().order).toEqual([]);
    // Nothing anywhere in the store remembers 'a'.
    expect(JSON.stringify(useFeedOrderStore.getState())).not.toContain('"a"');
  });
});

describe('unexcludeRetiredHardFilters', () => {
  it('resets rows nothing still matches back to unscored', async () => {
    mockGetStageRows.mockResolvedValue([row('a', { titleEn: 'Nvidia ships a GPU' })]);
    mockLoadPersona.mockResolvedValue(persona([])); // filter retired

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['a']);
    expect(r.stillExcluded).toBe(0);
    expect(mockBatchResetToUnscored).toHaveBeenCalledWith(['a']);
  });

  it('keeps a row excluded while a SECOND active filter still matches it', async () => {
    mockGetStageRows.mockResolvedValue([
      row('a', { titleEn: 'Nvidia ships a GPU', publicationName: 'The Verge' }),
      row('b', { titleEn: 'Nvidia ships another GPU', publicationName: 'Other' }),
    ]);
    // "nvidia" was retired; the publication mute is still active.
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'publication', value: 'the verge' }]),
    );

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['b']);
    expect(r.stillExcluded).toBe(1);
    expect(mockBatchResetToUnscored).toHaveBeenCalledWith(['b']);
  });

  it('does nothing when there is nothing excluded', async () => {
    mockGetStageRows.mockResolvedValue([]);
    const r = await unexcludeRetiredHardFilters();
    expect(r.resetIds).toEqual([]);
    expect(mockLoadPersona).not.toHaveBeenCalled();
    expect(mockBatchResetToUnscored).not.toHaveBeenCalled();
  });

  // HEADLINE GUARD. Headline rows are P6-exempt from hard-filter exclusion, so
  // an excluded one can only be the LOW-band cull. It matches no active filter
  // — precisely this sweep's release condition — so without the guard retiring
  // ANY unrelated filter would resurrect every culled headline and start a
  // re-score/re-cull churn loop.
  it('never resurrects a culled headline row', async () => {
    mockGetStageRows.mockResolvedValue([
      row('h', { titleEn: 'Country headline', headlineScope: 'COUNTRY' }),
    ]);
    mockLoadPersona.mockResolvedValue(persona([])); // every filter retired

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual([]);
    expect(mockBatchResetToUnscored).not.toHaveBeenCalled();
  });

  it('still releases a matching non-headline row alongside a culled headline', async () => {
    mockGetStageRows.mockResolvedValue([
      row('h', { titleEn: 'Country headline', headlineScope: 'GLOBAL' }),
      row('a', { titleEn: 'Nvidia ships a GPU' }),
    ]);
    mockLoadPersona.mockResolvedValue(persona([]));

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['a']);
    expect(mockBatchResetToUnscored).toHaveBeenCalledWith(['a']);
  });
});
