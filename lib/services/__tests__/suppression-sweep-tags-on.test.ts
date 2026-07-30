// suppression-sweep with EXPO_PUBLIC_USE_ARTICLE_TAGS **ON**.
//
// The flag-OFF arm lives in suppression-sweep.test.ts. This is the other half of
// the same rule: the tag-derived structured kinds (`entity` / `place` /
// `event_type`) are inert when the app is not using tagging data and LIVE when
// it is — which is what proves the gate is the flag, not a regression in the
// structured matcher.
//
// Its own file because `HARNESS_CONFIG_BASE` is read at module scope by
// suppression-sweep.ts; flipping it needs a fresh module registry, not a
// re-require inside one test case.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

// THE ONLY DIFFERENCE from suppression-sweep.test.ts's setup.
jest.mock('@/lib/mera-protocol/harness-config-base', () => {
  const { DEFAULT_HARNESS_CONFIG } = jest.requireActual('@/lib/news-harness/core/config');
  return {
    HARNESS_CONFIG_BASE: {
      ...DEFAULT_HARNESS_CONFIG,
      scoringEngine: { ...DEFAULT_HARNESS_CONFIG.scoringEngine, USE_ARTICLE_TAGS: true },
    },
  };
});

const mockLoadPersona = jest.fn();
const mockGetStageRows = jest.fn();
const mockBatchMarkExcluded = jest.fn().mockResolvedValue(undefined);
const mockRefreshStore = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  loadPersonaScoringContext: (...a: unknown[]) => mockLoadPersona(...a),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  ...jest.requireActual('@/lib/database/services/article-suggestion-service'),
  batchMarkExcluded: (...a: unknown[]) => mockBatchMarkExcluded(...a),
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
import { purgeHardFilteredSuggestions, refreshHardFilterLabels } from '../suppression-sweep';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
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

const persona = (
  hard: { keywords: string[]; strength: number; kind?: string; value?: string }[],
) => ({
  persona: { locations: [], pubPrefs: new Map(), softSuppressions: [], hardSuppressions: hard },
  topicWeights: new Map(),
});

beforeEach(() => {
  jest.clearAllMocks();
  useFeedOrderStore.setState({ hydrated: false, order: [], itemsById: {}, builtAt: null });
  useHardFilterLabelStore.getState().clear();
});

describe('suppression sweep — article tags ON', () => {
  it('an entity-kind filter DOES exclude a tagged row', async () => {
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

  it('a place-kind filter DOES match the geo tags', async () => {
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'place', value: 'bhopal' }]),
    );
    mockGetStageRows.mockResolvedValue([
      row('a', { geoTagsJson: JSON.stringify([{ city: 'Bhopal', countryCode: 'IN' }]) }),
      row('b', { geoTagsJson: JSON.stringify([{ city: 'Indore', countryCode: 'IN' }]) }),
    ]);

    const r = await purgeHardFilteredSuggestions();
    expect(r.excludedIds).toEqual(['a']);
  });

  it('labels a headline matched via an entity-kind filter (P6, tags on)', async () => {
    // The tags-on counterpart of headline-exemption-sweep.test.ts's P6 label
    // case: an exempt headline is demoted, never removed, and the label the card
    // renders is derived from the FULL stage row.
    mockLoadPersona.mockResolvedValue(
      persona([{ keywords: [], strength: 1, kind: 'entity', value: 'nvidia' }]),
    );
    mockGetStageRows.mockResolvedValue([
      row('head', { entitiesJson: JSON.stringify(['Nvidia']), headlineScope: 'COUNTRY' }),
    ]);

    const labels = await refreshHardFilterLabels();
    expect(labels.get('head')).toBe('nvidia');
  });
});
