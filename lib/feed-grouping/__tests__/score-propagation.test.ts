// score-propagation.test.ts — skip gate + same-sync election + post-results
// sibling propagation. The DB service is mocked; the pure story-grouping utility
// and the fail-open logger path run for real (logger is mocked to swallow).

const mockGetUnscoredGroupingRows = jest.fn();
const mockGetScoredDonorRows = jest.fn();
const mockBatchPropagateScores = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getUnscoredGroupingRows: (...args: any[]) => mockGetUnscoredGroupingRows(...args),
  getScoredDonorRows: (...args: any[]) => mockGetScoredDonorRows(...args),
  batchPropagateScores: (...args: any[]) => mockBatchPropagateScores(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    captureException: (...args: any[]) => mockCaptureException(...args),
  },
}));

import {
  gateUnscoredForScoring,
  propagateToUnscoredSiblings,
} from '../score-propagation';
import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';
import type { SuggestionGroupingRow } from '@/lib/database/services/article-suggestion-service';

// A single shared clusterId (confidence ≥ 0.5) unions every row that carries it
// into one story group regardless of title — the simplest deterministic edge.
function row(overrides: Partial<SuggestionGroupingRow> & { id: string }): SuggestionGroupingRow {
  return {
    title: overrides.title ?? null,
    clusters: overrides.clusters ?? [{ clusterId: 'c1', confidence: 0.9 }],
    relevance: overrides.relevance ?? 0,
    reason: overrides.reason ?? '',
    status: overrides.status ?? ('unscored' as any),
    firstPubDateMs: overrides.firstPubDateMs ?? 1_000,
    hasDescription: overrides.hasDescription ?? true,
    countryCode: overrides.countryCode ?? null,
    languageCode: overrides.languageCode ?? null,
    ...overrides,
  };
}

// A row that groups only with itself: unique clusterId + no title tokens.
function loneRow(id: string, overrides: Partial<SuggestionGroupingRow> = {}): SuggestionGroupingRow {
  return row({ id, clusters: [{ clusterId: `lone-${id}`, confidence: 0.9 }], ...overrides });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUnscoredGroupingRows.mockResolvedValue([]);
  mockGetScoredDonorRows.mockResolvedValue([]);
  mockBatchPropagateScores.mockResolvedValue(undefined);
});

// ===========================================================================
// gateUnscoredForScoring — donor propagation
// ===========================================================================

describe('gateUnscoredForScoring — donor propagation', () => {
  it('picks the max-relevance donor and copies its relevance + reason to every candidate in one batch', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'cand-1' }),
      row({ id: 'cand-2' }),
    ]);
    mockGetScoredDonorRows.mockResolvedValue([
      row({ id: 'donor-lo', status: 'complete' as any, relevance: 0.5, reason: 'low reason' }),
      row({ id: 'donor-hi', status: 'complete' as any, relevance: 0.8, reason: 'high reason' }),
    ]);

    const result = await gateUnscoredForScoring(new Set());

    expect(mockBatchPropagateScores).toHaveBeenCalledTimes(1);
    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'cand-1', relevance: 0.8, reason: 'high reason' },
      { id: 'cand-2', relevance: 0.8, reason: 'high reason' },
    ]);
    expect(result.propagatedCount).toBe(2);
    expect(result.heldBackCount).toBe(0);
    expect(result.enqueueIds).toEqual([]);
  });

  it('breaks a donor-relevance tie by newest firstPubDateMs', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([row({ id: 'cand-1' })]);
    mockGetScoredDonorRows.mockResolvedValue([
      row({ id: 'donor-old', status: 'complete' as any, relevance: 0.6, reason: 'old', firstPubDateMs: 1_000 }),
      row({ id: 'donor-new', status: 'complete' as any, relevance: 0.6, reason: 'new', firstPubDateMs: 5_000 }),
    ]);

    await gateUnscoredForScoring(new Set());

    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'cand-1', relevance: 0.6, reason: 'new' },
    ]);
  });

  it('propagates even a ≤0.3 donor (produces the hidden low-relevance tombstone shape; never deletes)', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([row({ id: 'cand-1' })]);
    mockGetScoredDonorRows.mockResolvedValue([
      row({ id: 'donor-weak', status: 'complete' as any, relevance: 0.2, reason: '' }),
    ]);

    const result = await gateUnscoredForScoring(new Set());

    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'cand-1', relevance: 0.2, reason: '' },
    ]);
    expect(result.propagatedCount).toBe(1);
    expect(result.enqueueIds).toEqual([]);
  });
});

// ===========================================================================
// gateUnscoredForScoring — same-sync election
// ===========================================================================

describe('gateUnscoredForScoring — same-sync election', () => {
  it('elects exactly one representative from a donor-less group of 3 and holds the other 2 back', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'a', hasDescription: true, firstPubDateMs: 1_000 }),
      row({ id: 'b', hasDescription: true, firstPubDateMs: 9_000 }), // newest → elected
      row({ id: 'c', hasDescription: true, firstPubDateMs: 2_000 }),
    ]);

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['b']);
    expect(result.heldBackCount).toBe(2);
    expect(result.propagatedCount).toBe(0);
    expect(mockBatchPropagateScores).not.toHaveBeenCalled();
  });

  it('prefers a candidate with a description when electing the representative', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'a', hasDescription: false, firstPubDateMs: 9_000 }),
      row({ id: 'b', hasDescription: true, firstPubDateMs: 1_000 }), // has description → elected
    ]);

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['b']);
    expect(result.heldBackCount).toBe(1);
  });

  it('enqueues donor-less singletons directly', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      loneRow('solo-1'),
      loneRow('solo-2'),
    ]);

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(expect.arrayContaining(['solo-1', 'solo-2']));
    expect(result.enqueueIds).toHaveLength(2);
    expect(result.heldBackCount).toBe(0);
    expect(result.propagatedCount).toBe(0);
    expect(mockBatchPropagateScores).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// gateUnscoredForScoring — country/language priority election (userCtx)
// ===========================================================================

describe('gateUnscoredForScoring — geo/language priority election', () => {
  // Home = USA (tier 0), one other country GBR (tier 1), app language fr (tier 2).
  const ctx: UserGeoLanguageContext = {
    homeCountryAlpha3: 'USA',
    otherCountriesAlpha3: ['GBR'],
    appLanguageBase: 'fr',
  };

  it('elects the HOME-country row over a has-description, newer sibling', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'home', countryCode: 'USA', hasDescription: false, firstPubDateMs: 1_000 }),
      row({ id: 'other', countryCode: null, languageCode: null, hasDescription: true, firstPubDateMs: 9_000 }),
    ]);

    const result = await gateUnscoredForScoring(new Set(), ctx);

    expect(result.enqueueIds).toEqual(['home']); // tier 0 beats has-description + newest
    expect(result.heldBackCount).toBe(1);
  });

  it('elects an OTHER-user-country row over an app-language row', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'other-country', countryCode: 'GBR', languageCode: 'de' }),
      row({ id: 'app-lang', countryCode: null, languageCode: 'fr' }),
    ]);

    const result = await gateUnscoredForScoring(new Set(), ctx);

    expect(result.enqueueIds).toEqual(['other-country']); // tier 1 beats tier 2
    expect(result.heldBackCount).toBe(1);
  });

  it('elects an APP-language row over a newer, tier-3 sibling', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'app-lang', countryCode: null, languageCode: 'fr', firstPubDateMs: 1_000 }),
      row({ id: 'rest', countryCode: null, languageCode: 'en', firstPubDateMs: 9_000 }),
    ]);

    const result = await gateUnscoredForScoring(new Set(), ctx);

    expect(result.enqueueIds).toEqual(['app-lang']); // tier 2 beats tier 3 despite newer sibling
    expect(result.heldBackCount).toBe(1);
  });

  it('preserves legacy election (description → newest) when userCtx is null', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      row({ id: 'home', countryCode: 'USA', hasDescription: false, firstPubDateMs: 9_000 }),
      row({ id: 'described', countryCode: null, hasDescription: true, firstPubDateMs: 1_000 }),
    ]);

    // No userCtx → every tier collapses to 3 → legacy tiebreaks decide.
    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['described']); // has-description wins, geo ignored
    expect(result.heldBackCount).toBe(1);
  });
});

// ===========================================================================
// gateUnscoredForScoring — in-flight exclusion + empties + fail-open
// ===========================================================================

describe('gateUnscoredForScoring — in-flight + edge cases', () => {
  it('excludes in-flight ids from the candidate set', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      loneRow('in-flight'),
      loneRow('fresh'),
    ]);

    const result = await gateUnscoredForScoring(new Set(['in-flight']));

    expect(result.enqueueIds).toEqual(['fresh']);
    expect(mockBatchPropagateScores).not.toHaveBeenCalled();
  });

  it('returns empty result and never queries donors when there are no candidates', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([]);

    const result = await gateUnscoredForScoring(new Set());

    expect(result).toEqual({ enqueueIds: [], propagatedCount: 0, heldBackCount: 0 });
    expect(mockGetScoredDonorRows).not.toHaveBeenCalled();
  });

  it('fails open: on a DB throw, enqueues all candidate ids and propagates nothing', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([loneRow('x'), loneRow('y')]);
    mockGetScoredDonorRows.mockRejectedValue(new Error('db down'));

    const result = await gateUnscoredForScoring(new Set());

    expect(result.propagatedCount).toBe(0);
    expect(result.heldBackCount).toBe(0);
    expect(result.enqueueIds).toEqual(['x', 'y']);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      { tags: { module: 'score-propagation' } },
    );
  });

  it('mixes propagation, election, and singletons across disjoint groups in one gate pass', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([
      // Group A (cluster cA): 1 candidate that will inherit a donor's score.
      row({ id: 'a-cand', clusters: [{ clusterId: 'cA', confidence: 0.9 }] }),
      // Group B (cluster cB): 2 candidates, no donor → elect one.
      row({ id: 'b1', clusters: [{ clusterId: 'cB', confidence: 0.9 }], hasDescription: true, firstPubDateMs: 5_000 }),
      row({ id: 'b2', clusters: [{ clusterId: 'cB', confidence: 0.9 }], hasDescription: true, firstPubDateMs: 1_000 }),
      // Group C: donor-less singleton.
      loneRow('c-solo'),
    ]);
    mockGetScoredDonorRows.mockResolvedValue([
      row({ id: 'a-donor', clusters: [{ clusterId: 'cA', confidence: 0.9 }], status: 'complete' as any, relevance: 0.7, reason: 'why' }),
    ]);

    const result = await gateUnscoredForScoring(new Set());

    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'a-cand', relevance: 0.7, reason: 'why' },
    ]);
    expect(result.propagatedCount).toBe(1);
    expect(result.heldBackCount).toBe(1); // b2 held back
    expect(result.enqueueIds).toEqual(expect.arrayContaining(['b1', 'c-solo']));
    expect(result.enqueueIds).toHaveLength(2);
  });
});

// ===========================================================================
// propagateToUnscoredSiblings — propagation only, no election
// ===========================================================================

describe('propagateToUnscoredSiblings', () => {
  it('copies a fresh donor score onto unscored siblings and returns the count', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([row({ id: 'cand-1' }), row({ id: 'cand-2' })]);
    mockGetScoredDonorRows.mockResolvedValue([
      row({ id: 'donor', status: 'complete' as any, relevance: 0.9, reason: 'r' }),
    ]);

    const n = await propagateToUnscoredSiblings(new Set());

    expect(n).toBe(2);
    expect(mockBatchPropagateScores).toHaveBeenCalledWith([
      { id: 'cand-1', relevance: 0.9, reason: 'r' },
      { id: 'cand-2', relevance: 0.9, reason: 'r' },
    ]);
  });

  it('does NOT elect or enqueue anything for donor-less groups (returns 0, no write)', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    mockGetScoredDonorRows.mockResolvedValue([]); // no donors

    const n = await propagateToUnscoredSiblings(new Set());

    expect(n).toBe(0);
    expect(mockBatchPropagateScores).not.toHaveBeenCalled();
  });

  it('excludes in-flight ids and short-circuits when no candidates remain', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([row({ id: 'busy' })]);

    const n = await propagateToUnscoredSiblings(new Set(['busy']));

    expect(n).toBe(0);
    expect(mockGetScoredDonorRows).not.toHaveBeenCalled();
    expect(mockBatchPropagateScores).not.toHaveBeenCalled();
  });

  it('fails open to 0 on a DB throw', async () => {
    mockGetUnscoredGroupingRows.mockResolvedValue([row({ id: 'a' })]);
    mockGetScoredDonorRows.mockRejectedValue(new Error('boom'));

    const n = await propagateToUnscoredSiblings(new Set());

    expect(n).toBe(0);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      { tags: { module: 'score-propagation' } },
    );
  });
});
