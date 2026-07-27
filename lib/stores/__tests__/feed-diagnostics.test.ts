// feed-diagnostics — pure funnel-report tests. RN-free.
//
// `feed-diagnostics.ts` takes every input as an argument and imports no DB /
// expo / react-native module, so this suite mocks NOTHING. If a mock ever
// becomes necessary here, the module has accidentally grown a non-pure import
// (most likely a VALUE import of feed-order-store, which instantiates the
// SQLite adapter at module load) — fix the module, don't add the mock.
//
// For the same reason this file never imports feed-order-store either, not even
// for `CardStateRecord`: the `cardStates` literals below are contextually typed
// through `FeedFunnelInput`.
//
// Covers: exclusive/inclusive visibility attribution + the sum invariants, the
// grouping collapse invariant, order/card-state/divider tallies, the
// `candidatesNotInOrder` replication of `feed-order-store.ingest`'s two-pass
// claim (including the split-off-sibling case), the cluster-gate
// counterfactual, hydrate provenance, deterministic capped samples, and the
// Sentry-safe scalar projection.

import {
  computeFeedFunnel,
  feedFunnelScalars,
  SAMPLE_LIMIT,
  SAMPLE_TITLE_MAX,
  type FeedFunnelInput,
  type HydrateProvenance,
} from '../feed-diagnostics';
import { FEED_WINDOW_MS } from '../fact-rows-selector';
import type { FeedListItem } from '../feed-list-selector';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ClusterMembership, ForYouSuggestion } from '../for-you-store';

const NOW = 1_000_000_000_000; // fixed clock — nothing here reads the wall clock
const H = 3_600_000;
const CUTOFF = NOW - FEED_WINDOW_MS;

// --- fixtures (same builders the sibling selector/store suites use) --------

let seq = 0;
function sugg(o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  seq += 1;
  const id = o._id ?? `s${seq}`;
  const pub = o.firstPubDate ?? new Date(NOW - H).toISOString();
  return {
    _id: id,
    articleId: o.articleId ?? `art-${id}`,
    clusters: o.clusters ?? [],
    relevance: o.relevance ?? 0.6,
    reason: o.reason ?? 'because',
    status: o.status ?? ArticleSuggestionStatus.Complete,
    country_code: o.country_code ?? null,
    language_code: o.language_code ?? 'en',
    publication_name: o.publication_name ?? 'Pub',
    // No title by default so fixtures never accidentally story-merge via shared
    // title tokens; grouping tests opt in via shared stable clusters instead.
    title_en: o.title_en ?? null,
    title_original: o.title_original ?? null,
    description_en: o.description_en ?? null,
    article_url: o.article_url ?? null,
    image_url: o.image_url ?? null,
    userTopicIds: o.userTopicIds ?? [],
    createdAt: o.createdAt ?? new Date(NOW - H).toISOString(),
    firstPubDate: pub,
    rawScore: o.rawScore ?? 0.5,
    eventType: o.eventType ?? null,
    headlineScope: o.headlineScope ?? null,
    matchedTopics: o.matchedTopics ?? [],
    factIds: o.factIds ?? [],
    scoredAt: o.scoredAt ?? null,
  };
}

function cluster(stableClusterId: string, confidence = 0.9): ClusterMembership {
  return { clusterId: `run-${stableClusterId}`, confidence, stableClusterId };
}

/** Persisted-order row fixture (mirrors feed-order-store.test.ts's `item`). */
function item(
  id: string,
  over: { cluster?: string | null; articleId?: string; memberIds?: string[] } = {},
): FeedListItem {
  const clusters = over.cluster ? [{ stableClusterId: over.cluster }] : [];
  const suggestion = {
    _id: id,
    articleId: over.articleId ?? id,
    firstPubDate: new Date(NOW - H).toISOString(),
    clusters,
  } as unknown as ForYouSuggestion;
  return {
    id,
    suggestion,
    memberCount: over.memberIds?.length ?? 1,
    memberIds: over.memberIds ?? [over.articleId ?? id],
    breaking: false,
    score: 0.5,
  };
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

/** A mixed pool: 1 visible, 2 not-complete, 1 sub-gate, 1 out-of-window, and
 *  one row that fails BOTH the status and the window axes. */
function mixedPool(): ForYouSuggestion[] {
  return [
    sugg({ _id: 'vis', relevance: 0.6 }),
    sugg({ _id: 'unscored', status: ArticleSuggestionStatus.Unscored }),
    sugg({ _id: 'pending', status: ArticleSuggestionStatus.ReasonPending }),
    sugg({ _id: 'subgate', relevance: 0.3 }), // must be strictly > 0.3
    sugg({ _id: 'stale', firstPubDate: new Date(NOW - FEED_WINDOW_MS - H).toISOString() }),
    // Two axes at once: unscored AND outside the publication window.
    sugg({
      _id: 'both',
      status: ArticleSuggestionStatus.Unscored,
      firstPubDate: new Date(NOW - FEED_WINDOW_MS - H).toISOString(),
    }),
  ];
}

// --- visibility attribution -----------------------------------------------

describe('computeFeedFunnel — visibility attribution', () => {
  it('attributes every row exactly once: dropped.* + visibleCount === totals.rows', () => {
    const r = computeFeedFunnel(baseInput({ suggestions: mixedPool() }));
    expect(r.totals.rows).toBe(6);
    expect(r.visibleCount).toBe(1);
    expect(r.dropped).toEqual({
      notComplete: 3,
      belowRelevanceGate: 1,
      outsideWindow: 1,
      unknownGate: 0,
    });
    const sum =
      r.dropped.notComplete +
      r.dropped.belowRelevanceGate +
      r.dropped.outsideWindow +
      r.dropped.unknownGate +
      r.visibleCount;
    expect(sum).toBe(r.totals.rows);
  });

  it('counts a two-axis failure in BOTH `failing` buckets but only ONE `dropped` bucket', () => {
    // `both` is unscored AND 30h old. `stale` is only out-of-window, `unscored`
    // and `pending` only not-complete — so `failing` overlaps where `dropped`
    // (first-failure-wins, matching isVisible's conjunction) does not.
    const r = computeFeedFunnel(baseInput({ suggestions: mixedPool() }));
    expect(r.failing).toEqual({
      notComplete: 3, // unscored, pending, both
      belowRelevanceGate: 1, // subgate
      outsideWindow: 2, // stale, both
    });
    // `both` landed in notComplete, not outsideWindow: status is checked first.
    expect(r.dropped.notComplete).toBe(3);
    expect(r.dropped.outsideWindow).toBe(1);
    // `failing` deliberately does NOT sum to totals.rows.
    expect(r.failing.notComplete + r.failing.belowRelevanceGate + r.failing.outsideWindow).toBe(6);
  });

  it('reports no unknown gate and all three sumsCheck flags true on normal input', () => {
    const r = computeFeedFunnel(baseInput({ suggestions: mixedPool() }));
    expect(r.dropped.unknownGate).toBe(0);
    expect(r.sumsCheck).toEqual({
      visibilityAttributionSums: true,
      memberSumMatchesVisible: true,
      orderReasonsSum: true,
    });
  });

  it('tallies totals.status across unscored / reason_pending / complete', () => {
    const r = computeFeedFunnel(baseInput({ suggestions: mixedPool() }));
    expect(r.totals.status).toEqual({
      unscored: 2,
      reasonPending: 1,
      complete: 3,
      other: 0,
    });
  });

  it('echoes the gates and the header numbers it was handed', () => {
    const r = computeFeedFunnel(
      baseInput({ suggestions: mixedPool(), headerAnalysedCount: 42, headerRelevantCount: 9 }),
    );
    expect(r.generatedAtMs).toBe(NOW);
    expect(r.gates.renderWindowMs).toBe(FEED_WINDOW_MS);
    expect(r.gates.renderCutoffMs).toBe(CUTOFF);
    expect(r.header).toEqual({ analysedCount: 42, relevantCount: 9, relevantMinusVisible: 8 });
  });
});

// --- grouping collapse ----------------------------------------------------

describe('computeFeedFunnel — grouping collapse', () => {
  it('Σ memberCount equals visibleCount for a pool with a multi-article cluster', () => {
    const pool = [
      sugg({ _id: 'c1', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - 3 * H).toISOString() }),
      sugg({ _id: 'c2', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - 2 * H).toISOString() }),
      sugg({ _id: 'c3', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - 1 * H).toISOString() }),
      sugg({ _id: 'solo1', clusters: [cluster('story-2')] }),
      sugg({ _id: 'solo2', clusters: [cluster('story-3')] }),
    ];
    const r = computeFeedFunnel(baseInput({ suggestions: pool }));
    expect(r.visibleCount).toBe(5);
    expect(r.groups.count).toBe(3);
    expect(r.groups.memberSum).toBe(5);
    expect(r.groups.memberSum).toBe(r.visibleCount);
    expect(r.groups.memberSumMatchesVisible).toBe(true);
    expect(r.sumsCheck.memberSumMatchesVisible).toBe(true);
    expect(r.groups.largestSize).toBe(3);
    expect(r.groups.collapseRatio).toBe(1.67); // 5 / 3, rounded to 2dp
    expect(r.candidates.count).toBe(3);
  });

  it('zeroes collapseRatio (rather than dividing by zero) when nothing is visible', () => {
    const r = computeFeedFunnel(
      baseInput({ suggestions: [sugg({ status: ArticleSuggestionStatus.Unscored })] }),
    );
    expect(r.groups.count).toBe(0);
    expect(r.groups.collapseRatio).toBe(0);
    expect(r.groups.memberSumMatchesVisible).toBe(true);
  });
});

// --- order stage ----------------------------------------------------------

describe('computeFeedFunnel — order stage', () => {
  it('counts an order id with no backing item as an orphan (rendered < order.length)', () => {
    const r = computeFeedFunnel(
      baseInput({
        order: ['art-x', 'ghost'],
        itemsById: { 'art-x': item('art-x') },
        builtAt: NOW - 5 * 60_000,
      }),
    );
    expect(r.orderStage.length).toBe(2);
    expect(r.orderStage.renderedCount).toBe(1);
    expect(r.orderStage.orphanCount).toBe(1);
    expect(r.orderStage.renderedCount).toBeLessThan(r.orderStage.length);
    expect(r.orderStage.builtAtMs).toBe(NOW - 5 * 60_000);
  });

  it('counts a cardStates entry whose id is not in order as stale, excluded from the tallies', () => {
    const r = computeFeedFunnel(
      baseInput({
        order: ['art-x'],
        itemsById: { 'art-x': item('art-x') },
        cardStates: {
          'art-x': { state: 'viewed', at: NOW },
          gone: { state: 'skipped', at: NOW },
        },
      }),
    );
    expect(r.cardStates.staleEntries).toBe(1);
    expect(r.cardStates.viewed).toBe(1);
    expect(r.cardStates.skipped).toBe(0); // the stale `skipped` entry is NOT tallied
    expect(r.cardStates.unviewed).toBe(0);
  });

  it('tallies skipped / viewed / unviewed against order length', () => {
    const r = computeFeedFunnel(
      baseInput({
        order: ['a', 'b', 'c', 'd'],
        itemsById: { a: item('a'), b: item('b'), c: item('c'), d: item('d') },
        cardStates: {
          a: { state: 'viewed', at: NOW },
          b: { state: 'skipped', at: NOW },
        },
      }),
    );
    expect(r.cardStates).toEqual({ skipped: 1, viewed: 1, unviewed: 2, staleEntries: 0 });
  });

  it('derives the divider from rendered-and-unseen rows (cardStates entry OR opened articleId)', () => {
    const r = computeFeedFunnel(
      baseInput({
        order: ['a', 'b', 'c', 'ghost'],
        itemsById: { a: item('a'), b: item('b'), c: item('c') },
        // a is seen via a card-state entry, b via the opened set, c is unseen.
        cardStates: { a: { state: 'skipped', at: NOW } },
        openedArticleIds: new Set(['b']),
      }),
    );
    expect(r.orderStage.renderedCount).toBe(3);
    expect(r.orderStage.aboveDividerCount).toBe(1); // only c
    expect(r.orderStage.dividerIndex).toBe(1);
    expect(r.orderStage.belowDividerCount).toBe(
      r.orderStage.renderedCount - (r.orderStage.aboveDividerCount ?? 0),
    );
    expect(r.orderStage.belowDividerCount).toBe(2);
  });

  it('surfaces the hydrated flags verbatim', () => {
    const r = computeFeedFunnel(baseInput({ orderHydrated: false, openedHydrated: true }));
    expect(r.hydrated).toEqual({ order: false, opened: true });
  });
});

// --- candidatesNotInOrder (replicates ingest's two-pass claim) -------------

describe('computeFeedFunnel — candidatesNotInOrder', () => {
  it('reports a candidate whose articleId is opened as `opened-by-article-id`', () => {
    const opened = sugg({ _id: 'o1' }); // articleId art-o1
    const r = computeFeedFunnel(
      baseInput({ suggestions: [opened], openedArticleIds: new Set(['art-o1']) }),
    );
    expect(r.candidatesNotInOrder.byReason['opened-by-article-id']).toBe(1);
    expect(r.candidatesNotInOrder.total).toBe(1);
    expect(r.candidatesNotInOrder.absent).toBe(1);
    expect(r.samples.missingFromOrder).toHaveLength(1);
    expect(r.samples.missingFromOrder[0]).toMatchObject({
      articleId: 'art-o1',
      reason: 'opened-by-article-id',
      matchedKey: 'art-o1',
    });
  });

  it('split-off siblings: the FIRST claims the shared order row, the second falls through', () => {
    // ONE order row whose stale memberIds still list BOTH articles. This mirrors
    // `feed-order-store.ingest`: the identity map is built only over UNCLAIMED
    // rows and each row can be claimed once, so the second sibling becomes a
    // genuinely-new card rather than stealing the row.
    const a = sugg({ _id: 'a', rawScore: 0.9 }); // higher score ⇒ first in `pending`
    const b = sugg({ _id: 'b', rawScore: 0.1 });
    const r = computeFeedFunnel(
      baseInput({
        suggestions: [a, b],
        order: ['art-old'],
        itemsById: { 'art-old': item('art-old', { memberIds: ['art-a', 'art-b'] }) },
      }),
    );

    expect(r.candidatesNotInOrder.byReason['represented-under-other-id']).toBe(1);
    expect(r.candidatesNotInOrder.byReason['not-yet-ingested']).toBe(1);
    expect(r.candidatesNotInOrder.byReason['duplicate-candidate-id']).toBe(0);
    expect(r.candidatesNotInOrder.byReason['opened-by-article-id']).toBe(0);

    // byReason sums to total; `absent` excludes the represented one.
    const reasonSum = Object.values(r.candidatesNotInOrder.byReason).reduce((x, y) => x + y, 0);
    expect(reasonSum).toBe(r.candidatesNotInOrder.total);
    expect(r.candidatesNotInOrder.total).toBe(2);
    expect(r.candidatesNotInOrder.absent).toBe(
      r.candidatesNotInOrder.total - r.candidatesNotInOrder.byReason['represented-under-other-id'],
    );
    expect(r.candidatesNotInOrder.absent).toBe(1);
    expect(r.sumsCheck.orderReasonsSum).toBe(true);

    // The represented sibling IS in the feed, so it is deliberately NOT sampled.
    expect(r.samples.missingFromOrder.map((s) => s.articleId)).toEqual(['art-b']);
    expect(r.samples.missingFromOrder[0].reason).toBe('not-yet-ingested');
  });

  it('an exact-id match in the order is claimed and never reported as missing', () => {
    const a = sugg({ _id: 'a' }); // candidate id = art-a
    const r = computeFeedFunnel(
      baseInput({
        suggestions: [a],
        order: ['art-a'],
        itemsById: { 'art-a': item('art-a') },
      }),
    );
    expect(r.candidatesNotInOrder.total).toBe(0);
    expect(r.samples.missingFromOrder).toEqual([]);
    expect(r.sumsCheck.orderReasonsSum).toBe(true);
  });
});

// --- the cluster-gate counterfactual --------------------------------------

describe('computeFeedFunnel — wouldBeBlockedByClusterGate', () => {
  it('counts only candidates the article-id gate let through whose cluster is in the union set', () => {
    // `c` is in the feed (its articleId is NOT opened) but its stableClusterId
    // IS in the union — the old cluster-wide gate would have eaten it.
    const c = sugg({ _id: 'c', clusters: [cluster('sc-c')] });
    // `d` is already excluded by the live article-id gate, so it must NOT be
    // counted even though its cluster is in the union too.
    const d = sugg({ _id: 'd', clusters: [cluster('sc-d')] });

    const r = computeFeedFunnel(
      baseInput({
        suggestions: [c, d],
        openedArticleIds: new Set(['art-d']),
        openedUnionIds: new Set(['sc-c', 'sc-d', 'art-d']),
      }),
    );
    expect(r.candidatesNotInOrder.byReason['opened-by-article-id']).toBe(1); // d
    expect(r.wouldBeBlockedByClusterGate).toBe(1); // c only
    expect(r.opened.articleIdSetSize).toBe(1);
    expect(r.opened.unionSetSize).toBe(3);
  });

  it('is zero when no candidate cluster is in the union set', () => {
    const c = sugg({ _id: 'c', clusters: [cluster('sc-c')] });
    const r = computeFeedFunnel(
      baseInput({ suggestions: [c], openedUnionIds: new Set(['unrelated']) }),
    );
    expect(r.wouldBeBlockedByClusterGate).toBe(0);
  });
});

// --- hydrate provenance ---------------------------------------------------

describe('computeFeedFunnel — hydrate provenance', () => {
  const stats = (emptyPoolGuardTripped: boolean): HydrateProvenance => ({
    persistedOrderCount: 40,
    candidateCountAtHydrate: emptyPoolGuardTripped ? 0 : 40,
    survivorCount: emptyPoolGuardTripped ? 0 : 38,
    emptyPoolGuardTripped,
  });

  it('mirrors emptyPoolGuardTripped into launchWipeSuspected', () => {
    const tripped = computeFeedFunnel(baseInput({ hydrateStats: stats(true) }));
    expect(tripped.launchWipeSuspected).toBe(true);
    expect(tripped.hydrateProvenance).toEqual(stats(true));

    const clean = computeFeedFunnel(baseInput({ hydrateStats: stats(false) }));
    expect(clean.launchWipeSuspected).toBe(false);
  });

  it('is false (not null/undefined) when hydrateStats is null', () => {
    const r = computeFeedFunnel(baseInput({ hydrateStats: null }));
    expect(r.launchWipeSuspected).toBe(false);
    expect(r.hydrateProvenance).toBeNull();
  });
});

// --- opened stats reconciliation ------------------------------------------

describe('computeFeedFunnel — opened reconciliation', () => {
  it('reports storeMinusDb, or null when the DB read failed', () => {
    const openedStats = {
      rowCount: 5,
      articleIdCount: 4,
      clusterIdCount: 1,
      unionSize: 4,
      oldestFirstSeenAtMs: NOW - 100 * H,
      newestLastSeenAtMs: NOW,
      ageBuckets: { le24h: 1, d1to7: 2, d7to30: 2 },
    };
    const withDb = computeFeedFunnel(
      baseInput({ openedUnionIds: new Set(['a', 'b', 'c', 'd', 'e']), openedStats }),
    );
    expect(withDb.opened.storeMinusDb).toBe(1);
    expect(withDb.opened.stats).toEqual(openedStats);

    const noDb = computeFeedFunnel(baseInput({ openedStats: null }));
    expect(noDb.opened.storeMinusDb).toBeNull();
    expect(noDb.opened.stats).toBeNull();
  });
});

// --- samples --------------------------------------------------------------

describe('computeFeedFunnel — samples', () => {
  it('caps each array at SAMPLE_LIMIT', () => {
    const pool: ForYouSuggestion[] = [];
    for (let i = 0; i < 30; i++) {
      pool.push(
        sugg({
          _id: `drop-${String(i).padStart(2, '0')}`,
          status: ArticleSuggestionStatus.Unscored,
          firstPubDate: new Date(NOW - (i + 1) * 60_000).toISOString(),
        }),
      );
    }
    // 30 visible candidates, none in the order ⇒ 30 missingFromOrder entries too.
    for (let i = 0; i < 30; i++) {
      pool.push(sugg({ _id: `cand-${String(i).padStart(2, '0')}`, clusters: [cluster(`sc-${i}`)] }));
    }
    const r = computeFeedFunnel(baseInput({ suggestions: pool }));
    expect(SAMPLE_LIMIT).toBe(25);
    expect(r.samples.droppedBeforeVisible).toHaveLength(SAMPLE_LIMIT);
    expect(r.samples.missingFromOrder).toHaveLength(SAMPLE_LIMIT);
    // ...while the COUNTS remain uncapped.
    expect(r.dropped.notComplete).toBe(30);
    expect(r.candidatesNotInOrder.total).toBe(30);
  });

  it('is deterministic: a shuffled copy of the same pool yields identical samples', () => {
    const pool: ForYouSuggestion[] = [];
    for (let i = 0; i < 30; i++) {
      pool.push(
        sugg({
          _id: `drop-${String(i).padStart(2, '0')}`,
          status: ArticleSuggestionStatus.Unscored,
          firstPubDate: new Date(NOW - (i + 1) * 60_000).toISOString(),
        }),
      );
    }
    // Grouping is pinned by EXPLICIT distinct stable cluster ids (never titles),
    // so reversing the input can't re-elect a representative under us.
    for (let i = 0; i < 10; i++) {
      pool.push(
        sugg({
          _id: `cand-${String(i).padStart(2, '0')}`,
          clusters: [cluster(`sc-${i}`)],
          firstPubDate: new Date(NOW - (i + 1) * 120_000).toISOString(),
        }),
      );
    }

    const a = computeFeedFunnel(baseInput({ suggestions: pool }));
    const b = computeFeedFunnel(baseInput({ suggestions: [...pool].reverse() }));
    expect(b.samples.droppedBeforeVisible).toEqual(a.samples.droppedBeforeVisible);
    expect(b.samples.missingFromOrder).toEqual(a.samples.missingFromOrder);
    // Sanity: the arrays are non-trivial.
    expect(a.samples.droppedBeforeVisible.length).toBeGreaterThan(0);
    expect(a.samples.missingFromOrder.length).toBeGreaterThan(0);
  });

  it('truncates titles longer than SAMPLE_TITLE_MAX', () => {
    const long = 'x'.repeat(SAMPLE_TITLE_MAX + 80);
    const short = 'y'.repeat(10);
    const r = computeFeedFunnel(
      baseInput({
        suggestions: [
          sugg({ _id: 'long', status: ArticleSuggestionStatus.Unscored, title_en: long }),
          sugg({ _id: 'short', status: ArticleSuggestionStatus.Unscored, title_en: short }),
        ],
      }),
    );
    const byId = Object.fromEntries(r.samples.droppedBeforeVisible.map((s) => [s.suggestionId, s]));
    expect(SAMPLE_TITLE_MAX).toBe(120);
    expect(byId.long.title).toBe(`${'x'.repeat(SAMPLE_TITLE_MAX)}…`);
    expect(byId.long.title).toHaveLength(SAMPLE_TITLE_MAX + 1);
    expect(byId.short.title).toBe(short); // short titles pass through untouched
  });

  it('carries the per-row detail the share payload needs', () => {
    const r = computeFeedFunnel(
      baseInput({
        suggestions: [
          sugg({
            _id: 'drop1',
            status: ArticleSuggestionStatus.ReasonPending,
            relevance: 0.42,
            firstPubDate: new Date(NOW - 2 * H).toISOString(),
          }),
        ],
      }),
    );
    expect(r.samples.droppedBeforeVisible[0]).toEqual({
      suggestionId: 'drop1',
      articleId: 'art-drop1',
      title: '',
      status: 'reason_pending',
      relevance: 0.42,
      ageHours: 2,
      memberCount: null,
      reason: 'not-complete',
      matchedKey: null,
    });
  });
});

// --- edge cases -----------------------------------------------------------

describe('computeFeedFunnel — edge cases', () => {
  it('produces zeroed, self-consistent output for an empty pool and empty order', () => {
    const r = computeFeedFunnel(baseInput());
    expect(r.totals.rows).toBe(0);
    expect(r.totals.status).toEqual({ unscored: 0, reasonPending: 0, complete: 0, other: 0 });
    expect(r.visibleCount).toBe(0);
    expect(r.dropped).toEqual({
      notComplete: 0,
      belowRelevanceGate: 0,
      outsideWindow: 0,
      unknownGate: 0,
    });
    expect(r.failing).toEqual({ notComplete: 0, belowRelevanceGate: 0, outsideWindow: 0 });
    expect(r.groups).toEqual({
      count: 0,
      largestSize: 0,
      memberSum: 0,
      memberSumMatchesVisible: true,
      collapseRatio: 0,
    });
    expect(r.candidates).toEqual({
      count: 0,
      breakingCount: 0,
      topScore: null,
      lowestScore: null,
    });
    expect(r.orderStage).toEqual({
      builtAtMs: null,
      length: 0,
      renderedCount: 0,
      orphanCount: 0,
      dividerIndex: 0,
      aboveDividerCount: 0,
      belowDividerCount: 0,
    });
    expect(r.cardStates).toEqual({ skipped: 0, viewed: 0, unviewed: 0, staleEntries: 0 });
    expect(r.candidatesNotInOrder).toEqual({
      total: 0,
      absent: 0,
      byReason: {
        'represented-under-other-id': 0,
        'opened-by-article-id': 0,
        'duplicate-candidate-id': 0,
        'not-yet-ingested': 0,
      },
    });
    expect(r.wouldBeBlockedByClusterGate).toBe(0);
    expect(r.samples).toEqual({ droppedBeforeVisible: [], missingFromOrder: [] });
    expect(r.sumsCheck).toEqual({
      visibilityAttributionSums: true,
      memberSumMatchesVisible: true,
      orderReasonsSum: true,
    });
  });

  it('does not throw on an order full of orphans with no suggestions at all', () => {
    expect(() =>
      computeFeedFunnel(baseInput({ order: ['g1', 'g2', 'g3'], itemsById: {} })),
    ).not.toThrow();
    const r = computeFeedFunnel(baseInput({ order: ['g1', 'g2', 'g3'], itemsById: {} }));
    expect(r.orderStage.orphanCount).toBe(3);
    expect(r.orderStage.renderedCount).toBe(0);
    expect(r.orderStage.aboveDividerCount).toBe(0);
    expect(r.orderStage.belowDividerCount).toBe(0);
    expect(r.cardStates.unviewed).toBe(3);
  });

  it('never depends on the wall clock — the same input at a different real time is identical', () => {
    const pool = mixedPool();
    const first = computeFeedFunnel(baseInput({ suggestions: pool }));
    const second = computeFeedFunnel(baseInput({ suggestions: pool }));
    expect(second).toEqual(first);
    // A different injected `nowMs` DOES change the report — proving nowMs, not
    // Date.now(), is what drives it. Shift far enough past FEED_WINDOW_MS that
    // every row in the pool (newest is `NOW - H`) falls out of the window
    // regardless of how wide that window is.
    const shiftedNowMs = NOW + FEED_WINDOW_MS + H;
    const shifted = computeFeedFunnel(baseInput({ suggestions: pool, nowMs: shiftedNowMs }));
    expect(shifted.visibleCount).toBe(0);
    expect(shifted.gates.renderCutoffMs).toBe(shiftedNowMs - FEED_WINDOW_MS);
  });
});

// --- feedFunnelScalars ----------------------------------------------------

describe('feedFunnelScalars', () => {
  function richReport() {
    const pool = [
      ...mixedPool(),
      sugg({ _id: 'g1', clusters: [cluster('sc-g1')] }),
      // g2 is NOT in the order, so it really lands in `samples.missingFromOrder`
      // carrying a long title — which is what makes the leak assertion below
      // meaningful rather than vacuous.
      sugg({ _id: 'g2', clusters: [cluster('sc-g2')], title_en: 'z'.repeat(400) }),
    ];
    return computeFeedFunnel(
      baseInput({
        suggestions: pool,
        order: ['art-g1', 'ghost'],
        itemsById: { 'art-g1': item('art-g1') },
        cardStates: { 'art-g1': { state: 'viewed', at: NOW }, stale: { state: 'skipped', at: NOW } },
        openedArticleIds: new Set(['art-x']),
        openedUnionIds: new Set(['art-x', 'sc-g2']),
        headerAnalysedCount: 100,
        headerRelevantCount: 12,
        hydrateStats: {
          persistedOrderCount: 12,
          candidateCountAtHydrate: 0,
          survivorCount: 0,
          emptyPoolGuardTripped: true,
        },
        openedStats: {
          rowCount: 3,
          articleIdCount: 2,
          clusterIdCount: 1,
          unionSize: 2,
          oldestFirstSeenAtMs: NOW - 200 * H,
          newestLastSeenAtMs: NOW,
          ageBuckets: { le24h: 1, d1to7: 1, d7to30: 1 },
        },
      }),
    );
  }

  it('is flat: every value is a number, boolean or string — no arrays, no nested objects', () => {
    const scalars = feedFunnelScalars(richReport());
    for (const [key, value] of Object.entries(scalars)) {
      // `typeof [] === 'object'` and `typeof {} === 'object'`, so this single
      // check rejects arrays AND nested objects. The key is folded into the
      // matched string so a failure names the offending field.
      expect(`${key}:${typeof value}`).toMatch(/:(number|boolean|string)$/);
      expect(Array.isArray(value)).toBe(false);
    }
    expect(Object.keys(scalars).length).toBeGreaterThan(0);
  });

  it('keeps every string value under the 200-char Sentry PII cap', () => {
    const scalars = feedFunnelScalars(richReport());
    for (const [key, value] of Object.entries(scalars)) {
      if (typeof value === 'string') {
        expect(`${key}:${value.length <= 200}`).toBe(`${key}:true`);
      }
    }
  });

  it('does not include samples in any form (capStringValues skips arrays)', () => {
    const report = richReport();
    expect(report.samples.droppedBeforeVisible.length).toBeGreaterThan(0);
    // A sampled row really does carry a long (truncated) title, so the
    // "no title text leaked" assertion below has something to catch.
    expect(report.samples.missingFromOrder.some((s) => s.title.startsWith('z'.repeat(50)))).toBe(
      true,
    );

    const scalars = feedFunnelScalars(report);
    expect(scalars).not.toHaveProperty('samples');
    expect(Object.keys(scalars).some((k) => k.toLowerCase().includes('sample'))).toBe(false);
    // No value carries a sampled title through under another name.
    const serialized = JSON.stringify(scalars);
    expect(serialized).not.toContain('z'.repeat(50));
    expect(serialized).not.toContain('suggestionId');
  });

  it('projects the headline counters faithfully', () => {
    const report = richReport();
    const scalars = feedFunnelScalars(report);
    expect(scalars.rows).toBe(report.totals.rows);
    expect(scalars.visible).toBe(report.visibleCount);
    expect(scalars.groups).toBe(report.groups.count);
    expect(scalars.orphans).toBe(report.orderStage.orphanCount);
    expect(scalars.staleCardStates).toBe(report.cardStates.staleEntries);
    expect(scalars.missingFromOrder).toBe(report.candidatesNotInOrder.absent);
    expect(scalars.launchWipeSuspected).toBe(true);
    expect(scalars.sumsOk).toBe(true);
    expect(scalars.openedRows).toBe(3);
    expect(scalars.openedOlderThan7d).toBe(1);
  });

  it('substitutes -1 for the nullable fields rather than emitting null', () => {
    const scalars = feedFunnelScalars(computeFeedFunnel(baseInput()));
    expect(scalars.openedRows).toBe(-1);
    expect(scalars.openedOlderThan7d).toBe(-1);
    for (const value of Object.values(scalars)) expect(value).not.toBeNull();
  });
});
