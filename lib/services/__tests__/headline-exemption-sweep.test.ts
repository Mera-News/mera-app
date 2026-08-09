// P6 — call site 3 of 3: the RETROACTIVE purge.
//
// This is the one that would have quietly undone the exemption. The sweep
// screens ALL stored rows blindly and marks the matches terminal `excluded`
// AND evicts them from the Feed tab's persisted order — so a headline the
// scoring stage deliberately kept would be killed on the very next "add a
// filter" sweep, and the two halves would fight forever.
//
// It also pins the OTHER half of P6: the labels. A filtered-but-shown card must
// say so, and the label is derived from the same matcher over the same
// rehydrated rows, so it can never under-label the way a partial re-match
// against the trimmed store row would.

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
// `buildStageCandidateInput` stays REAL — rehydrating the stored scorer columns
// (including `headline_scope`) is exactly what decides the exemption here.
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
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
import {
  purgeHardFilteredSuggestions,
  refreshHardFilterLabels,
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

const persona = (hard: { keywords: string[]; strength: number }[]) => ({
  persona: {
    locations: [],
    pubPrefs: new Map(),
    softSuppressions: [],
    hardSuppressions: hard,
  },
  topicWeights: new Map(),
});

const NVIDIA = [{ keywords: ['nvidia'], strength: 1 }];

/** One matching normal row and one matching HEADLINE row. */
const bothRows = () => [
  row('normal', { titleEn: 'Nvidia ships a GPU' }),
  row('head', { titleEn: 'Nvidia ships a GPU', headlineScope: 'GLOBAL' }),
];

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
  useHardFilterLabelStore.getState().clear();
});

describe('purgeHardFilteredSuggestions — headline rows survive the purge', () => {
  it('marks only the non-headline match excluded', async () => {
    mockLoadPersona.mockResolvedValue(persona(NVIDIA));
    mockGetStageRows.mockResolvedValue(bothRows());

    const r = await purgeHardFilteredSuggestions(123);

    expect(r.excludedIds).toEqual(['normal']);
    expect(mockBatchMarkExcluded).toHaveBeenCalledWith(['normal'], 123);
  });

  it('does NOT evict the headline row from the Feed tab', async () => {
    mockLoadPersona.mockResolvedValue(persona(NVIDIA));
    mockGetStageRows.mockResolvedValue(bothRows());
    seedFeedOrder(['normal', 'head', 'other']);

    const r = await purgeHardFilteredSuggestions();

    expect(r.evictedFromFeed).toBe(1);
    expect(useFeedOrderStore.getState().order).toEqual(['head', 'other']);
  });

  it('is a full no-op when the ONLY matches are headlines', async () => {
    mockLoadPersona.mockResolvedValue(persona(NVIDIA));
    mockGetStageRows.mockResolvedValue([bothRows()[1]]);
    seedFeedOrder(['head']);

    const r = await purgeHardFilteredSuggestions();

    expect(r.excludedIds).toEqual([]);
    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
    expect(useFeedOrderStore.getState().order).toEqual(['head']);
  });
});

describe('refreshHardFilterLabels — the card label', () => {
  it('publishes the matching filter for the headline row and nothing for the normal one', async () => {
    mockLoadPersona.mockResolvedValue(persona(NVIDIA));
    mockGetStageRows.mockResolvedValue(bothRows());

    const labels = await refreshHardFilterLabels();

    expect([...labels.keys()]).toEqual(['head']);
    expect(labels.get('head')).toBe('nvidia');
    expect(useHardFilterLabelStore.getState().labels).toEqual({ head: 'nvidia' });
  });

  it('labels nothing — and reads no rows — when there are no hard filters', async () => {
    mockLoadPersona.mockResolvedValue(persona([]));
    const labels = await refreshHardFilterLabels();
    expect(labels.size).toBe(0);
    expect(mockGetStageRows).not.toHaveBeenCalled();
    expect(useHardFilterLabelStore.getState().labels).toEqual({});
  });

  it('drops a stale label once the filter is retired (no cleanup step needed)', async () => {
    mockLoadPersona.mockResolvedValue(persona(NVIDIA));
    mockGetStageRows.mockResolvedValue(bothRows());
    await refreshHardFilterLabels();
    expect(useHardFilterLabelStore.getState().labels).toEqual({ head: 'nvidia' });

    mockLoadPersona.mockResolvedValue(persona([]));
    await refreshHardFilterLabels();
    expect(useHardFilterLabelStore.getState().labels).toEqual({});
  });

  it('labels a headline matched via a STRUCTURED kind the trimmed store row could not see', async () => {
    // `category` never reaches ForYouSuggestion — deriving the label at render
    // time would silently miss this row, which is the surprise P6 exists to end.
    //
    // Uses `category` rather than `entity` — both are structured kinds reading a
    // column the trimmed store row does not carry, and the `entity` version is
    // covered by the test below.
    mockLoadPersona.mockResolvedValue({
      persona: {
        locations: [],
        pubPrefs: new Map(),
        softSuppressions: [],
        hardSuppressions: [{ keywords: [], strength: 1, kind: 'category', value: 'technology' }],
      },
      topicWeights: new Map(),
    });
    mockGetStageRows.mockResolvedValue([
      row('head', { category: 'technology', headlineScope: 'COUNTRY' }),
    ]);

    const labels = await refreshHardFilterLabels();
    expect(labels.get('head')).toBe('technology');
  });

  // The label is what tells the reader WHY a card is dimmed. It follows
  // exclusion exactly (both go through `toScreeningInputs` + the same screen),
  // so a tag-derived kind that CAN exclude also labels. `place` is used here:
  // `entity` can no longer exclude, so it can no longer label either — asserted
  // in the test below.
  it('DOES label via a TAG-derived kind', async () => {
    mockLoadPersona.mockResolvedValue({
      persona: {
        locations: [],
        pubPrefs: new Map(),
        softSuppressions: [],
        hardSuppressions: [{ keywords: [], strength: 1, kind: 'place', value: 'taipei' }],
      },
      topicWeights: new Map(),
    });
    mockGetStageRows.mockResolvedValue([
      row('head', {
        geoTagsJson: JSON.stringify([{ city: 'Taipei', countryCode: 'TWN' }]),
        headlineScope: 'COUNTRY',
      }),
    ]);

    const labels = await refreshHardFilterLabels();
    expect(labels.get('head')).toBe('taipei');
  });

  it('does NOT label via an entity filter — it never excluded, so there is nothing to explain', async () => {
    // Labelling a card for a filter that did not remove anything would be a
    // claim we cannot stand behind at 68.8% extraction accuracy.
    mockLoadPersona.mockResolvedValue({
      persona: {
        locations: [],
        pubPrefs: new Map(),
        softSuppressions: [],
        hardSuppressions: [{ keywords: [], strength: 1, kind: 'entity', value: 'nvidia' }],
      },
      topicWeights: new Map(),
    });
    mockGetStageRows.mockResolvedValue([
      row('head', { entitiesJson: JSON.stringify(['Nvidia']), headlineScope: 'COUNTRY' }),
    ]);

    const labels = await refreshHardFilterLabels();
    expect(labels.size).toBe(0);
  });
});

describe('unexcludeRetiredHardFilters — headline rows are never released', () => {
  // SUPERSEDED. This case used to assert the opposite: a headline excluded by a
  // PRE-P6 build was released back to `unscored` even while its filter still
  // matched, because after P6 a headline is no longer a reason to keep a row
  // out. That migration is over — `article_suggestions` are hard-deleted at
  // SUGGESTION_TTL_MS (48h, lib/scheduler/tasks/data-cleanup-task.ts), so no
  // pre-P6 excluded row can exist on any device any more.
  //
  // What the same shape means now is the LOW-band top-headline cull, which
  // writes `excluded` for a SCORING OUTCOME rather than a filter. Releasing one
  // would re-score it, reproduce the identical LOW verdict, and cull it again —
  // an inference-paid churn loop fired by retiring any unrelated filter. Since
  // P6 makes headlines exempt from hard-filter exclusion, `excluded` +
  // `headlineScope != null` is unambiguously the cull, and the sweep skips it.
  it('leaves a culled headline excluded even when every filter is retired', async () => {
    mockLoadPersona.mockResolvedValue(persona([]));
    mockGetStageRows.mockResolvedValue(bothRows());

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual(['normal']);
    expect(mockBatchResetToUnscored).toHaveBeenCalledWith(['normal']);
  });

  it('leaves it excluded while its filter is still active, too', async () => {
    mockLoadPersona.mockResolvedValue(persona(NVIDIA));
    mockGetStageRows.mockResolvedValue(bothRows());

    const r = await unexcludeRetiredHardFilters();

    expect(r.resetIds).toEqual([]);
    // Only the non-headline row was screened; the filter still matches it.
    expect(r.stillExcluded).toBe(1);
    expect(mockBatchResetToUnscored).not.toHaveBeenCalled();
  });
});
