// feed-diagnostics — the "did the article arrive tagged" readout.
//
// This is the block that makes the server-side tagging backfill observable:
// rows move from `legacy` (untagged) into `math` (tagged) as the server starts
// emitting geo/entity/event columns. It is NOT "which scorer ran" — since the
// judge was removed every row is scored by the LLM — and the
// `EXPO_PUBLIC_USE_ARTICLE_TAGS` flag it used to also report is deleted.
//
// It is a SEPARATE AXIS from the visibility funnel on purpose, and the tests
// below pin that: adding it must not disturb
// `sumsCheck.visibilityAttributionSums`, which the Observability screen renders
// a loud "inconsistent" banner for.

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import {
  computeFeedFunnel,
  feedFunnelScalars,
  type FeedFunnelInput,
} from '../feed-diagnostics';

const NOW = Date.UTC(2026, 6, 30, 12);
const H = 3_600_000;

function sugg(over: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'x',
    articleId: 'x',
    clusters: [],
    relevance: 0.6,
    reason: 'because',
    status: ArticleSuggestionStatus.Complete,
    firstPubDate: new Date(NOW - H).toISOString(),
    ...over,
  } as unknown as ForYouSuggestion;
}

function baseInput(over: Partial<FeedFunnelInput> = {}): FeedFunnelInput {
  return {
    suggestions: [],
    openedArticleIds: new Set<string>(),
    openedUnionIds: new Set<string>(),
    order: [],
    itemsById: {},
    cardStates: {},
    builtAt: null,
    orderHydrated: true,
    openedHydrated: true,
    hydrateStats: null,
    headerAnalysedCount: 0,
    headerRelevantCount: 0,
    openedStats: null,
    userCtx: null,
    nowMs: NOW,
    ...over,
  };
}

describe('computeFeedFunnel — scoring-path readout', () => {
  it('reports the tagged/untagged split', () => {
    const r = computeFeedFunnel(
      baseInput({
        scoringModes: { math: 7, backstop: 3, unknown: 1 },
      }),
    );
    expect(r.scoring.math).toBe(7);
    expect(r.scoring.legacy).toBe(3);
    expect(r.scoring.unknown).toBe(1);
    expect(r.scoring.scoredRows).toBe(11);
    expect(r.scoring.available).toBe(true);
  });

  it('an all-untagged pool reads as 100% legacy — every row scored before the backfill', () => {
    const r = computeFeedFunnel(
      baseInput({ scoringModes: { math: 0, backstop: 42, unknown: 0 } }),
    );
    expect(r.scoring.math).toBe(0);
    expect(r.scoring.legacy).toBe(42);
  });

  it('marks the block UNAVAILABLE when the breakdown read failed', () => {
    // The distinction that matters: zeroes-because-unavailable must never be
    // read as "nothing was scored by either path".
    const r = computeFeedFunnel(baseInput({ scoringModes: null }));
    expect(r.scoring.available).toBe(false);
    expect(r.scoring.math).toBe(0);
    expect(r.scoring.legacy).toBe(0);
  });

  it('defaults to unavailable when the caller passes no breakdown', () => {
    // The Feed tab's dev-only funnel log calls computeFeedFunnel without
    // touching the database; it must keep working unchanged.
    const r = computeFeedFunnel(baseInput());
    expect(r.scoring.available).toBe(false);
  });
});

describe('computeFeedFunnel — the new block does not disturb the funnel', () => {
  const pool = [
    sugg({ _id: 'vis', relevance: 0.6 }),
    sugg({ _id: 'unscored', status: ArticleSuggestionStatus.Unscored }),
    sugg({ _id: 'gone', status: ArticleSuggestionStatus.Excluded }),
  ];

  it('keeps visibilityAttributionSums green', () => {
    const r = computeFeedFunnel(
      baseInput({ suggestions: pool, scoringModes: { math: 5, backstop: 5, unknown: 0 } }),
    );
    expect(r.sumsCheck.visibilityAttributionSums).toBe(true);
    expect(
      r.dropped.excluded +
        r.dropped.notComplete +
        r.dropped.belowRelevanceGate +
        r.dropped.outsideWindow +
        r.dropped.unknownGate +
        r.visibleCount,
    ).toBe(pool.length);
  });

  it('leaves every visibility number identical whether or not the breakdown is supplied', () => {
    const withModes = computeFeedFunnel(
      baseInput({ suggestions: pool, scoringModes: { math: 5, backstop: 5, unknown: 0 } }),
    );
    const without = computeFeedFunnel(baseInput({ suggestions: pool }));
    expect(withModes.totals).toEqual(without.totals);
    expect(withModes.dropped).toEqual(without.dropped);
    expect(withModes.visibleCount).toBe(without.visibleCount);
    expect(withModes.sumsCheck).toEqual(without.sumsCheck);
  });
});

describe('feedFunnelScalars — Sentry-bound projection', () => {
  it('carries the scoring split', () => {
    const s = feedFunnelScalars(
      computeFeedFunnel(
        baseInput({ scoringModes: { math: 2, backstop: 8, unknown: 0 } }),
      ),
    );
    expect(s.scoredByMath).toBe(2);
    expect(s.scoredByLlm).toBe(8);
  });

  it('substitutes -1 (never null) when the breakdown is unavailable', () => {
    const s = feedFunnelScalars(computeFeedFunnel(baseInput()));
    expect(s.scoredByMath).toBe(-1);
    expect(s.scoredByLlm).toBe(-1);
    expect(s.scoredByUnknown).toBe(-1);
    for (const value of Object.values(s)) expect(value).not.toBeNull();
  });
});
