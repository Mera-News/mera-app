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
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'entity', value: 'nvidia' }]),
    );
    mockGetStageRows.mockResolvedValue([
      row('a', { entitiesJson: JSON.stringify(['Nvidia']) }),
      row('b', { entitiesJson: JSON.stringify(['AMD']) }),
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
});
