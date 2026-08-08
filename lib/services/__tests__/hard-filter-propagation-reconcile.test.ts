// P9 regression — score propagation must not smuggle a hard-"Blocked" article
// into the feed.
//
// The hole this pins: `batchPropagateScores` copies a scored donor's relevance
// onto its unscored story siblings and marks them terminal `complete`. Those
// rows never enter computeMathStage/computeAndJudge, which is the ONLY place
// `screenHardSuppressions` runs during scoring. So a newly-synced article that
// an active hard filter blocks could inherit a passing (> 0.3) score from a
// sibling and render — while the UI badges the filter "Blocked / Never show me
// these at all".
//
// These tests run the REAL story grouping, the REAL propagation, and the REAL
// shared matcher (`screenHardSuppressions` via `purgeHardFilteredByIds`) end to
// end; only the DB reads/writes and the persona snapshot are stubbed. Against
// the pre-fix code `propagateToUnscoredSiblings` ignored the reconcile hook, so
// `getStageRowsByIds` / `batchMarkExcluded` were never reached and the blocked
// row stayed renderable.

jest.mock('@/lib/database/index', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

const mockGetUnscoredGroupingRows = jest.fn();
const mockGetScoredDonorRows = jest.fn();
const mockBatchPropagateScores = jest.fn().mockResolvedValue(undefined);
const mockGetStageRowsByIds = jest.fn();
const mockBatchMarkExcluded = jest.fn().mockResolvedValue(undefined);
const mockLoadPersona = jest.fn();
const mockRefreshStore = jest.fn().mockResolvedValue(undefined);

// `buildStageCandidateInput` stays REAL — rehydrating the stored scorer columns
// into what the matcher reads is precisely what must not drift.
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  ...jest.requireActual('@/lib/database/services/article-suggestion-service'),
  getUnscoredGroupingRows: (...a: unknown[]) => mockGetUnscoredGroupingRows(...a),
  getScoredDonorRows: (...a: unknown[]) => mockGetScoredDonorRows(...a),
  batchPropagateScores: (...a: unknown[]) => mockBatchPropagateScores(...a),
  getStageRowsByIds: (...a: unknown[]) => mockGetStageRowsByIds(...a),
  batchMarkExcluded: (...a: unknown[]) => mockBatchMarkExcluded(...a),
}));
jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  loadPersonaScoringContext: (...a: unknown[]) => mockLoadPersona(...a),
}));
jest.mock('../SuggestionSyncService', () => ({
  refreshSuggestionsInStoreUnsafe: () => mockRefreshStore(),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), captureException: jest.fn() },
}));

import { propagateToUnscoredSiblings } from '@/lib/feed-grouping/score-propagation';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';
import type { SuggestionGroupingRow } from '@/lib/database/services/article-suggestion-service';
import { purgeHardFilteredByIds } from '../suppression-sweep';

/** Rows sharing clusterId `c1` at high confidence form ONE story group, which
 *  is exactly the edge propagation copies a score across. */
const groupingRow = (
  id: string,
  over: Partial<SuggestionGroupingRow> = {},
): SuggestionGroupingRow => ({
  id,
  title: null,
  clusters: [{ clusterId: 'c1', confidence: 0.9 }],
  relevance: 0,
  reason: '',
  status: 'unscored' as SuggestionGroupingRow['status'],
  firstPubDateMs: 1_000,
  hasDescription: true,
  countryCode: null,
  languageCode: null,
  ...over,
});

const stageRow = (id: string, over: Partial<StageCandidateRow> = {}): StageCandidateRow => ({
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

const personaWithHard = (
  hard: { keywords: string[]; strength: number; kind?: string; value?: string }[],
) => ({
  persona: { locations: [], pubPrefs: new Map(), softSuppressions: [], hardSuppressions: hard },
  topicWeights: new Map(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchPropagateScores.mockResolvedValue(undefined);
  mockBatchMarkExcluded.mockResolvedValue(undefined);
  mockRefreshStore.mockResolvedValue(undefined);
  useFeedOrderStore.setState({ hydrated: false, order: [], itemsById: {}, builtAt: null });
});

describe('score propagation × hard filters (P9)', () => {
  it('does NOT leave a hard-filtered article renderable after it inherits a passing donor score', async () => {
    // One story: a donor already scored 0.9 (well above the 0.3 render gate) and
    // two freshly-synced siblings. "blocked" matches an ACTIVE hard filter.
    mockGetUnscoredGroupingRows.mockResolvedValue([
      groupingRow('blocked'),
      groupingRow('ok'),
    ]);
    mockGetScoredDonorRows.mockResolvedValue([
      groupingRow('donor', {
        status: 'complete' as SuggestionGroupingRow['status'],
        relevance: 0.9,
        reason: 'why',
      }),
    ]);
    mockLoadPersona.mockResolvedValue(
      personaWithHard([{ keywords: ['nvidia'], strength: 1 }]),
    );
    mockGetStageRowsByIds.mockResolvedValue([
      stageRow('blocked', { titleEn: 'Nvidia ships a GPU' }),
      stageRow('ok', { titleEn: 'AMD ships a GPU' }),
    ]);

    const propagated = await propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds);

    // Precondition of the bug: both siblings DID inherit the donor's 0.9 and
    // were written terminal `complete` without ever meeting the hard screen.
    expect(propagated).toBe(2);
    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'blocked', relevance: 0.9, reason: 'why', scoredWithV3: null },
      { id: 'ok', relevance: 0.9, reason: 'why', scoredWithV3: null },
    ]);

    // The fix: exactly those ids get re-screened, and the blocked one is made
    // terminal `excluded` so it cannot render.
    expect(mockGetStageRowsByIds).toHaveBeenCalledWith(['blocked', 'ok']);
    expect(mockBatchMarkExcluded).toHaveBeenCalledTimes(1);
    expect(mockBatchMarkExcluded.mock.calls[0][0]).toEqual(['blocked']);
    // ...and the sibling nothing matches is left alone.
    expect(mockBatchMarkExcluded.mock.calls[0][0]).not.toContain('ok');
  });

  it('evicts the blocked id from the persisted Feed order it had already been laid out in', async () => {
    useFeedOrderStore.setState({
      hydrated: true,
      order: ['blocked', 'ok'],
      itemsById: { blocked: { id: 'blocked' } as never, ok: { id: 'ok' } as never },
    });
    mockGetUnscoredGroupingRows.mockResolvedValue([groupingRow('blocked'), groupingRow('ok')]);
    mockGetScoredDonorRows.mockResolvedValue([
      groupingRow('donor', {
        status: 'complete' as SuggestionGroupingRow['status'],
        relevance: 0.9,
        reason: 'why',
      }),
    ]);
    mockLoadPersona.mockResolvedValue(
      personaWithHard([{ keywords: [], strength: 1, kind: 'publication', value: 'the verge' }]),
    );
    mockGetStageRowsByIds.mockResolvedValue([
      stageRow('blocked', { publicationName: 'The Verge' }),
      stageRow('ok', { publicationName: 'Other' }),
    ]);

    await propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds);

    expect(useFeedOrderStore.getState().order).toEqual(['ok']);
    expect(mockRefreshStore).toHaveBeenCalled();
  });

  it('costs nothing when the user has no hard filters (no row read, no write)', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([groupingRow('a'), groupingRow('b')]);
    mockGetScoredDonorRows.mockResolvedValue([
      groupingRow('donor', {
        status: 'complete' as SuggestionGroupingRow['status'],
        relevance: 0.9,
        reason: 'why',
      }),
    ]);
    mockLoadPersona.mockResolvedValue(personaWithHard([]));

    const propagated = await propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds);

    expect(propagated).toBe(2);
    expect(mockGetStageRowsByIds).not.toHaveBeenCalled();
    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
  });

  it('a reconcile failure never fails the propagation (already committed)', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([groupingRow('a')]);
    mockGetScoredDonorRows.mockResolvedValue([
      groupingRow('donor', {
        status: 'complete' as SuggestionGroupingRow['status'],
        relevance: 0.9,
        reason: 'why',
      }),
    ]);
    mockLoadPersona.mockRejectedValue(new Error('persona unavailable'));

    await expect(
      propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds),
    ).resolves.toBe(1);
  });
});
