// feed-diagnostics — an ON-DEMAND explanation of "why is my For you feed
// showing N cards". Answers the question the raw counts cannot: the header says
// 79 relevant articles and the feed shows 3, and almost all of that gap is
// legitimate (`reason_pending` rows, and story grouping
// collapsing many articles into one card) — but some of it may not be.
//
// PURE + RN-FREE, same invariant as feed-list-selector. It takes every input as
// an argument and imports no DB / expo / react-native module. In particular it
// must NEVER import feed-order-store: that pulls in the settings service and
// through it `lib/database/index.ts`, which instantiates a SQLite adapter at
// module load. Store state arrives here as plain data.
//
// COST: computed only when the Observability screen refreshes. It is not on the
// render, ingest, or scroll path, and nothing on those paths imports this file.
//
// It reuses the real predicates (`isVisible`'s sub-gates, `isOpenedId`,
// `buildFeedList`, `resolveExistingOrderId`) rather than re-implementing them,
// so it cannot drift from the pipeline it describes. Where it must replicate
// control flow — `ingest`'s two-pass claim — that is called out inline as a
// paired edit.

import {
  FEED_WINDOW_MS,
  effectiveRenderGate,
  isComplete,
  isOpenedId,
  isVisible,
  isWithinWindow,
  passesRenderGate,
} from './fact-rows-selector';
import {
  buildFeedList,
  resolveExistingOrderId,
  stableClusterIdOf,
  type FeedListItem,
} from './feed-list-selector';
import type {
  ScoringModeBreakdown,
  SharedNoteBreakdown,
} from '@/lib/database/services/article-suggestion-service';
import type { CardStateRecord } from './feed-order-store';
import type { ForYouSuggestion } from './for-you-store';
import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';

/** Max per-article rows in each `samples` array. Share payload only. */
export const SAMPLE_LIMIT = 25;
/** Sample titles are truncated to keep the share payload readable. */
export const SAMPLE_TITLE_MAX = 120;

/** Why a suggestion never reached the visible pool. EXCLUSIVE: the first
 *  failure in this exact order wins, mirroring `isVisible`'s conjunction, so
 *  `dropped.* + visibleCount === totals.rows`. */
export type FeedFunnelVisibilityReason =
  /** A hard "not interested" filter matched — the user asked never to see it.
   *  Checked FIRST: an excluded row also fails `not-complete` and
   *  `below-relevance-gate`, and attributing it to either would read as a
   *  pipeline problem rather than as the user's own decision. */
  | 'excluded'
  | 'not-complete'
  | 'below-relevance-gate'
  | 'outside-window'
  /** All three sub-predicates passed yet `isVisible` said no — a fourth gate was
   *  added without a matching sub-predicate. Non-zero means THIS MODULE is
   *  stale, not that the feed is broken. */
  | 'unknown-gate';

/** Not a failure at all — the row rendered. Exists so the `visible` sample
 *  array can reuse `FeedFunnelSample` rather than growing a near-duplicate
 *  shape whose only difference is the missing reason. */
export type FeedFunnelVisibleReason = 'visible';

/** Why a candidate story has no exact-id entry in the persisted order.
 *  EXCLUSIVE, in the same precedence `feed-order-store.ingest` applies. */
export type FeedFunnelOrderReason =
  /** The story IS in the feed, under an older order id (rep-switch). */
  | 'represented-under-other-id'
  | 'opened-by-article-id'
  | 'duplicate-candidate-id'
  /** Residual: ingest has not run since this candidate appeared. Normal while
   *  the Feed tab is unfocused — ingest only runs when focused + hydrated. */
  | 'not-yet-ingested';

/** Bounded per-article detail. SHARE PAYLOAD ONLY — never Sentry-bound, see
 *  the note on `feedFunnelScalars`. */
export interface FeedFunnelSample {
  suggestionId: string;
  articleId: string;
  title: string;
  status: string;
  relevance: number;
  ageHours: number;
  memberCount: number | null;
  /** The AI-generated note as STORED on the row, truncated. This is the field
   *  the whole "is the note about this article?" question is asked of — a
   *  sample carrying a title and a note side by side lets a reader answer it by
   *  eye, which no aggregate count can do. Empty when the row has none. */
  note: string;
  reason: FeedFunnelVisibilityReason | FeedFunnelOrderReason | FeedFunnelVisibleReason;
  /** For `opened-by-article-id` / `represented-under-other-id`: the key that
   *  matched, or the order id it folded into. */
  matchedKey: string | null;
}

export interface OpenedSeenAgeBuckets {
  le24h: number;
  d1to7: number;
  d7to30: number;
}

export interface OpenedSeenStats {
  rowCount: number;
  articleIdCount: number;
  clusterIdCount: number;
  unionSize: number;
  oldestFirstSeenAtMs: number | null;
  newestLastSeenAtMs: number | null;
  ageBuckets: OpenedSeenAgeBuckets;
}

export interface HydrateProvenance {
  persistedOrderCount: number;
  candidateCountAtHydrate: number;
  survivorCount: number;
  emptyPoolGuardTripped: boolean;
}

export interface FeedFunnelInput {
  /** The whole uncapped `article_suggestions` pool from the store. */
  suggestions: ForYouSuggestion[];
  /** Exact article ids opened on any surface — the Feed's real ingest gate. */
  openedArticleIds: Set<string>;
  /** article ids ∪ stable cluster ids — still used by the Dashboard + P_SEEN.
   *  Only used here for the `wouldBeBlockedByClusterGate` counterfactual. */
  openedUnionIds: Set<string>;

  // feed-order-store snapshot, as plain data (the store is never imported).
  order: string[];
  itemsById: Record<string, FeedListItem>;
  cardStates: Record<string, CardStateRecord>;
  builtAt: number | null;
  orderHydrated: boolean;
  openedHydrated: boolean;
  hydrateStats: HydrateProvenance | null;

  /** The exact numbers `FeedStatsSentence` rendered, for reconciliation. */
  headerAnalysedCount: number;
  headerRelevantCount: number;

  /** DB-side opened breakdown; null when that read failed. */
  openedStats: OpenedSeenStats | null;

  /** DB-side count of which scoring path produced each stored score, read from
   *  the `score_components_json` audit. Null when that read failed OR was not
   *  requested. Optional so the Feed tab's dev-only funnel log (which does not
   *  touch the database) keeps calling this with no change. */
  scoringModes?: ScoringModeBreakdown | null;
  /** Shared-note counts from the DB. Null ⇒ the read failed or was not
   *  requested, which the report distinguishes from "nothing is shared". */
  sharedNotes?: SharedNoteBreakdown | null;
  /** Whether the app is currently honouring server article tags
   *  (`EXPO_PUBLIC_USE_ARTICLE_TAGS` → `ScoringEngineConfig.USE_ARTICLE_TAGS`).
   *  Passed in rather than imported: this module is pure and RN-free, and the
   *  flag lives in the composition root. */
  useArticleTags?: boolean;

  userCtx: UserGeoLanguageContext | null;
  /** Captured ONCE by the caller and used for every window/age computation. */
  nowMs: number;
}

export interface FeedFunnelReport {
  generatedAtMs: number;
  /** False ⇒ every number below is meaningless by construction, not broken. */
  hydrated: { order: boolean; opened: boolean };

  gates: {
    renderGate: number;
    renderWindowMs: number;
    renderCutoffMs: number;
  };

  totals: {
    rows: number;
    status: {
      unscored: number;
      reasonPending: number;
      complete: number;
      /** Terminal, removed by a hard "not interested" filter. */
      excluded: number;
      other: number;
    };
  };

  /** INCLUSIVE / overlapping — a row failing two axes counts in both. Does NOT
   *  sum to `totals.rows`. */
  failing: { notComplete: number; belowRelevanceGate: number; outsideWindow: number };

  /** EXCLUSIVE, first-failure-wins. `dropped.* + visibleCount === totals.rows`. */
  dropped: {
    excluded: number;
    notComplete: number;
    belowRelevanceGate: number;
    outsideWindow: number;
    unknownGate: number;
  };
  visibleCount: number;

  header: {
    analysedCount: number;
    relevantCount: number;
    /** ROWS minus ROWS — the window/status gap. NOT "articles lost": the
     *  grouping collapse below accounts for most of the rest. */
    relevantMinusVisible: number;
  };

  groups: {
    count: number;
    largestSize: number;
    memberSum: number;
    /** Invariant: with an empty exclusion set `buildFeedList` emits one item per
     *  group, so Σ memberCount must equal `visibleCount`. */
    memberSumMatchesVisible: boolean;
    /** visibleCount / groupCount — rows collapsed into one story card. */
    collapseRatio: number;
  };

  candidates: {
    count: number;
    breakingCount: number;
    topScore: number | null;
    lowestScore: number | null;
  };

  orderStage: {
    builtAtMs: number | null;
    length: number;
    /** Order ids that resolve to a live item — what the list actually renders. */
    renderedCount: number;
    /** Order ids with no `itemsById` entry (silently invisible rows). */
    orphanCount: number;
    dividerIndex: number | null;
    aboveDividerCount: number | null;
    belowDividerCount: number | null;
  };

  cardStates: {
    skipped: number;
    viewed: number;
    /** order.length − (skipped + viewed) — absence means unviewed. */
    unviewed: number;
    /** Entries whose id is not in `order`. Nothing prunes these any more, so a
     *  slow drift here is expected, not a leak to chase. */
    staleEntries: number;
  };

  candidatesNotInOrder: {
    total: number;
    /** total minus `represented-under-other-id` — the genuinely absent ones. */
    absent: number;
    byReason: Record<FeedFunnelOrderReason, number>;
  };

  /** COUNTERFACTUAL, not a live rejection reason. Candidates that pass the
   *  narrowed exact-article-id gate but WOULD have been dropped by the old
   *  cluster-wide union check — i.e. how many cards the 30-day cluster
   *  suppression was eating. Reporting this as a live reason would read 0
   *  forever now that the condition is gone. */
  wouldBeBlockedByClusterGate: number;

  opened: {
    articleIdSetSize: number;
    unionSetSize: number;
    /** Live store size minus DB size. Briefly non-zero after an optimistic
     *  mark; large or negative means hydrate failed. */
    storeMinusDb: number | null;
    stats: OpenedSeenStats | null;
  };

  /** WHICH SCORER RAN — the `EXPO_PUBLIC_USE_ARTICLE_TAGS` A/B readout.
   *
   *  A SEPARATE AXIS from `totals.status` / `dropped.*`, deliberately. Those two
   *  partition the pool by VISIBILITY and are tied together by
   *  `sumsCheck.visibilityAttributionSums`; scoring path is an orthogonal
   *  property of an already-scored row, so adding it as a bucket there would
   *  break that identity for no reason. It has its own self-check instead. */
  scoring: {
    /** Is the app honouring server article tags right now? */
    useArticleTags: boolean;
    /** Scored by the deterministic math engine (article carried tags). */
    math: number;
    /** Scored by the legacy two-pass LLM (untagged → `backstop`). */
    legacy: number;
    /** Scored, but the audit blob can't say which path — see
     *  `ScoringModeBreakdown.unknown`. */
    unknown: number;
    /** math + legacy + unknown. Compare against `totals.status.complete +
     *  reasonPending`: a large shortfall means rows were scored by a build that
     *  predates the audit field, not that scoring is broken. */
    scoredRows: number;
    /** False ⇒ the breakdown read failed or was not requested, and the four
     *  numbers above are zeroes by construction rather than measurements.
     *  Rendered explicitly so an all-zero row is never read as "nothing was
     *  scored by either path". */
    available: boolean;
  };

  /** ARE ANY NOTES SHARED BETWEEN ARTICLES — the readout that says which
   *  mechanism put a foreign sentence on a card.
   *
   *  Only propagation copies a note verbatim, so a shared string is its
   *  signature; a decode shift or a model confabulating from its own prompt
   *  exemplar each produce a sentence that exists exactly once. Sharing in
   *  moderation is normal (propagation is deliberate) — it is a LARGE group, or
   *  one whose members are plainly different stories, that indicts grouping. */
  sharedNotes: {
    rowsWithNote: number;
    distinctNotes: number;
    sharedNoteGroups: number;
    rowsSharingANote: number;
    largestGroupSize: number;
    largestGroup: { note: string; titles: string[] } | null;
    /** False ⇒ the numbers above are zeroes by construction, not measurements.
     *  Same reason `scoring.available` exists. */
    available: boolean;
  };

  hydrateProvenance: HydrateProvenance | null;
  /** The persisted READING ORDER was thrown away at launch. `ingest` refills the
   *  list so everything else reads healthy — this is the only visible symptom. */
  launchWipeSuspected: boolean;

  /** Self-checks. Any false means the report is lying — render it loudly. */
  sumsCheck: {
    visibilityAttributionSums: boolean;
    memberSumMatchesVisible: boolean;
    orderReasonsSum: boolean;
  };

  /** SHARE PAYLOAD ONLY. Capped and totally ordered so repeat runs match. */
  samples: {
    /** Rows that RENDERED, highest relevance first — each with its stored note
     *  next to its title, so "is this note about this article?" is answerable
     *  by reading one row. */
    visible: FeedFunnelSample[];
    droppedBeforeVisible: FeedFunnelSample[];
    missingFromOrder: FeedFunnelSample[];
  };
}

function parseMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function ageHours(s: ForYouSuggestion, nowMs: number): number {
  const pub = parseMs(s.firstPubDate);
  if (pub === 0) return -1;
  return Math.round(((nowMs - pub) / 3_600_000) * 10) / 10;
}

function makeSample(
  s: ForYouSuggestion,
  reason: FeedFunnelVisibilityReason | FeedFunnelOrderReason | FeedFunnelVisibleReason,
  nowMs: number,
  memberCount: number | null = null,
  matchedKey: string | null = null,
): FeedFunnelSample {
  const title = s.title_en ?? s.title_original ?? '';
  const note = s.reason ?? '';
  return {
    suggestionId: s._id,
    articleId: s.articleId,
    title: title.length > SAMPLE_TITLE_MAX ? `${title.slice(0, SAMPLE_TITLE_MAX)}…` : title,
    status: String(s.status),
    relevance: s.relevance ?? 0,
    ageHours: ageHours(s, nowMs),
    memberCount,
    note: note.length > SAMPLE_TITLE_MAX ? `${note.slice(0, SAMPLE_TITLE_MAX)}…` : note,
    reason,
    matchedKey,
  };
}

/** Total order so a re-run on shuffled input yields identical samples. */
function bySuggestionRecency(a: FeedFunnelSample, b: FeedFunnelSample): number {
  if (a.ageHours !== b.ageHours) return a.ageHours - b.ageHours;
  return a.suggestionId < b.suggestionId ? -1 : a.suggestionId > b.suggestionId ? 1 : 0;
}

export function computeFeedFunnel(input: FeedFunnelInput): FeedFunnelReport {
  const { nowMs } = input;
  const modes = input.scoringModes ?? null;
  const shared = input.sharedNotes ?? null;
  const cutoffMs = nowMs - FEED_WINDOW_MS;

  // ── Stage 1: visibility, with exclusive reason attribution ────────────────
  const status = { unscored: 0, reasonPending: 0, complete: 0, excluded: 0, other: 0 };
  const failing = { notComplete: 0, belowRelevanceGate: 0, outsideWindow: 0 };
  const dropped = {
    excluded: 0,
    notComplete: 0,
    belowRelevanceGate: 0,
    outsideWindow: 0,
    unknownGate: 0,
  };
  const droppedSamples: FeedFunnelSample[] = [];
  // The rows that rendered. Every other sample array in this report explains an
  // ABSENCE, which is the right question when the feed is empty — but the
  // question here is about a card the user is looking at, and nothing in the
  // report could previously show one.
  const visibleSamples: FeedFunnelSample[] = [];
  let visibleCount = 0;

  for (const s of input.suggestions) {
    const st = String(s.status);
    if (st === 'unscored') status.unscored++;
    else if (st === 'reason_pending') status.reasonPending++;
    else if (st === 'complete') status.complete++;
    else if (st === 'excluded') status.excluded++;
    else status.other++;

    if (isVisible(s, cutoffMs)) {
      visibleCount++;
      visibleSamples.push(makeSample(s, 'visible', nowMs));
      continue;
    }

    const okStatus = isComplete(s);
    const okRelevance = passesRenderGate(s);
    const okWindow = isWithinWindow(s, cutoffMs);
    if (!okStatus) failing.notComplete++;
    if (!okRelevance) failing.belowRelevanceGate++;
    if (!okWindow) failing.outsideWindow++;

    const reason: FeedFunnelVisibilityReason =
      st === 'excluded'
        ? 'excluded'
        : !okStatus
          ? 'not-complete'
          : !okRelevance
            ? 'below-relevance-gate'
            : !okWindow
              ? 'outside-window'
              : 'unknown-gate';
    dropped[
      reason === 'excluded'
        ? 'excluded'
        : reason === 'not-complete'
          ? 'notComplete'
          : reason === 'below-relevance-gate'
            ? 'belowRelevanceGate'
            : reason === 'outside-window'
              ? 'outsideWindow'
              : 'unknownGate'
    ]++;
    droppedSamples.push(makeSample(s, reason, nowMs));
  }

  // ── Stages 2-3: grouping + representative election ────────────────────────
  // Reuse buildFeedList rather than re-running buildStoryGroups. With an empty
  // exclusion set it emits exactly one item per group, so `candidates.length`
  // IS the group count and Σ memberCount must equal visibleCount.
  const candidates = buildFeedList(input.suggestions, new Set<string>(), nowMs, input.userCtx);
  let memberSum = 0;
  let largestSize = 0;
  let breakingCount = 0;
  let topScore: number | null = null;
  let lowestScore: number | null = null;
  for (const c of candidates) {
    memberSum += c.memberCount;
    if (c.memberCount > largestSize) largestSize = c.memberCount;
    if (c.breaking) breakingCount++;
    if (topScore === null || c.score > topScore) topScore = c.score;
    if (lowestScore === null || c.score < lowestScore) lowestScore = c.score;
  }

  // ── Stage 4: order membership, replicating ingest's two-pass claim ────────
  // PAIRED EDIT: this mirrors `feed-order-store.ingest`. Building the identity
  // map over ALL of itemsById (rather than only unclaimed rows) would report
  // `represented-under-other-id` for split-off siblings that ingest actually
  // treats as genuinely-new cards.
  const inOrder = new Set(input.order);
  const claimed = new Set<string>();
  const pending: FeedListItem[] = [];
  for (const c of candidates) {
    if (inOrder.has(c.id)) claimed.add(c.id);
    else pending.push(c);
  }

  const identityToOrderId = new Map<string, string>();
  for (const id of input.order) {
    if (claimed.has(id)) continue;
    const existing = input.itemsById[id];
    if (!existing) continue;
    const scid = stableClusterIdOf(existing);
    if (scid) identityToOrderId.set(scid, id);
    for (const mid of existing.memberIds ?? []) identityToOrderId.set(mid, id);
  }

  const byReason: Record<FeedFunnelOrderReason, number> = {
    'represented-under-other-id': 0,
    'opened-by-article-id': 0,
    'duplicate-candidate-id': 0,
    'not-yet-ingested': 0,
  };
  const missingSamples: FeedFunnelSample[] = [];
  const seenNew = new Set<string>();
  let wouldBeBlockedByClusterGate = 0;

  for (const c of pending) {
    const oldId = resolveExistingOrderId(c, identityToOrderId);
    if (oldId && !claimed.has(oldId)) {
      claimed.add(oldId);
      byReason['represented-under-other-id']++;
      continue; // the story IS in the feed — deliberately not sampled
    }

    const articleId = c.suggestion.articleId;
    if (articleId && input.openedArticleIds.has(articleId)) {
      byReason['opened-by-article-id']++;
      missingSamples.push(
        makeSample(c.suggestion, 'opened-by-article-id', nowMs, c.memberCount, articleId),
      );
      continue;
    }

    // Counterfactual: this candidate IS in the feed, but the old cluster-wide
    // union gate would have dropped it. Measured after the live gate so it only
    // counts cards the narrowing actually rescued.
    const scid = stableClusterIdOf(c);
    if (isOpenedId(null, scid, input.openedUnionIds)) wouldBeBlockedByClusterGate++;

    if (seenNew.has(c.id)) {
      byReason['duplicate-candidate-id']++;
      missingSamples.push(
        makeSample(c.suggestion, 'duplicate-candidate-id', nowMs, c.memberCount),
      );
      continue;
    }
    seenNew.add(c.id);
    byReason['not-yet-ingested']++;
    missingSamples.push(makeSample(c.suggestion, 'not-yet-ingested', nowMs, c.memberCount));
  }

  const notInOrderTotal =
    byReason['represented-under-other-id'] +
    byReason['opened-by-article-id'] +
    byReason['duplicate-candidate-id'] +
    byReason['not-yet-ingested'];

  // ── Order + card-state tallies ────────────────────────────────────────────
  let renderedCount = 0;
  let orphanCount = 0;
  for (const id of input.order) {
    if (input.itemsById[id]) renderedCount++;
    else orphanCount++;
  }

  let skipped = 0;
  let viewed = 0;
  let staleEntries = 0;
  for (const [id, rec] of Object.entries(input.cardStates)) {
    if (!inOrder.has(id)) {
      staleEntries++;
      continue;
    }
    if (rec.state === 'viewed') viewed++;
    else skipped++;
  }

  // Divider position, derived rather than passed in: it is exactly the count of
  // RENDERED rows that are not yet seen. Mirrors `isSeenEntry` in
  // components/custom/feed/feed-entries.ts — kept as a local expression rather
  // than importing a component module into lib/stores.
  let aboveDividerCount = 0;
  for (const id of input.order) {
    const it = input.itemsById[id];
    if (!it) continue;
    const seen =
      !!input.cardStates[id] ||
      (!!it.suggestion.articleId && input.openedArticleIds.has(it.suggestion.articleId));
    if (!seen) aboveDividerCount++;
  }
  const dividerIndex = aboveDividerCount;
  const belowDividerCount = Math.max(0, renderedCount - aboveDividerCount);

  const memberSumMatchesVisible = memberSum === visibleCount;
  const visibilityAttributionSums =
    dropped.excluded +
      dropped.notComplete +
      dropped.belowRelevanceGate +
      dropped.outsideWindow +
      dropped.unknownGate +
      visibleCount ===
    input.suggestions.length;

  return {
    generatedAtMs: nowMs,
    hydrated: { order: input.orderHydrated, opened: input.openedHydrated },
    gates: {
      renderGate: effectiveRenderGate(),
      renderWindowMs: FEED_WINDOW_MS,
      renderCutoffMs: cutoffMs,
    },
    totals: { rows: input.suggestions.length, status },
    failing,
    dropped,
    visibleCount,
    header: {
      analysedCount: input.headerAnalysedCount,
      relevantCount: input.headerRelevantCount,
      relevantMinusVisible: input.headerRelevantCount - visibleCount,
    },
    groups: {
      count: candidates.length,
      largestSize,
      memberSum,
      memberSumMatchesVisible,
      collapseRatio:
        candidates.length > 0
          ? Math.round((visibleCount / candidates.length) * 100) / 100
          : 0,
    },
    candidates: {
      count: candidates.length,
      breakingCount,
      topScore: topScore === null ? null : Math.round(topScore * 1000) / 1000,
      lowestScore: lowestScore === null ? null : Math.round(lowestScore * 1000) / 1000,
    },
    orderStage: {
      builtAtMs: input.builtAt,
      length: input.order.length,
      renderedCount,
      orphanCount,
      dividerIndex,
      aboveDividerCount,
      belowDividerCount,
    },
    cardStates: {
      skipped,
      viewed,
      unviewed: Math.max(0, input.order.length - skipped - viewed),
      staleEntries,
    },
    candidatesNotInOrder: {
      total: notInOrderTotal,
      absent: notInOrderTotal - byReason['represented-under-other-id'],
      byReason,
    },
    wouldBeBlockedByClusterGate,
    opened: {
      articleIdSetSize: input.openedArticleIds.size,
      unionSetSize: input.openedUnionIds.size,
      storeMinusDb:
        input.openedStats === null ? null : input.openedUnionIds.size - input.openedStats.unionSize,
      stats: input.openedStats,
    },
    scoring: {
      useArticleTags: input.useArticleTags ?? false,
      math: modes?.math ?? 0,
      legacy: modes?.backstop ?? 0,
      unknown: modes?.unknown ?? 0,
      scoredRows: modes ? modes.math + modes.backstop + modes.unknown : 0,
      available: modes != null,
    },
    sharedNotes: {
      rowsWithNote: shared?.rowsWithNote ?? 0,
      distinctNotes: shared?.distinctNotes ?? 0,
      sharedNoteGroups: shared?.sharedNoteGroups ?? 0,
      rowsSharingANote: shared?.rowsSharingANote ?? 0,
      largestGroupSize: shared?.largestGroupSize ?? 0,
      largestGroup: shared?.largestGroup ?? null,
      available: shared != null,
    },
    hydrateProvenance: input.hydrateStats,
    launchWipeSuspected: !!input.hydrateStats?.emptyPoolGuardTripped,
    sumsCheck: {
      visibilityAttributionSums,
      memberSumMatchesVisible,
      orderReasonsSum: notInOrderTotal === pending.length,
    },
    samples: {
      // Highest-scoring first: a note that misdescribes its article is most
      // damaging on the cards that rank highest, and those are the ones the
      // reader actually saw.
      visible: visibleSamples
        .sort((a, b) => b.relevance - a.relevance || bySuggestionRecency(a, b))
        .slice(0, SAMPLE_LIMIT),
      droppedBeforeVisible: droppedSamples.sort(bySuggestionRecency).slice(0, SAMPLE_LIMIT),
      missingFromOrder: missingSamples.sort(bySuggestionRecency).slice(0, SAMPLE_LIMIT),
    },
  };
}

/**
 * Flat projection: every value is a number | boolean | short string.
 *
 * This is the ONLY shape that may ever be Sentry-bound. `capStringValues` in
 * lib/sentry-init.ts recurses plain objects but deliberately skips ARRAYS, so
 * putting `report.samples` into `event.extra` would smuggle untruncated article
 * titles past the 200-char PII redaction. Keep this array-free and object-free.
 */
export function feedFunnelScalars(r: FeedFunnelReport): Record<string, number | boolean | string> {
  return {
    rows: r.totals.rows,
    statusUnscored: r.totals.status.unscored,
    statusReasonPending: r.totals.status.reasonPending,
    statusComplete: r.totals.status.complete,
    statusExcluded: r.totals.status.excluded,
    visible: r.visibleCount,
    droppedExcluded: r.dropped.excluded,
    droppedNotComplete: r.dropped.notComplete,
    droppedBelowGate: r.dropped.belowRelevanceGate,
    droppedOutsideWindow: r.dropped.outsideWindow,
    droppedUnknownGate: r.dropped.unknownGate,
    headerRelevant: r.header.relevantCount,
    headerRelevantMinusVisible: r.header.relevantMinusVisible,
    groups: r.groups.count,
    collapseRatio: r.groups.collapseRatio,
    largestGroup: r.groups.largestSize,
    candidates: r.candidates.count,
    orderLength: r.orderStage.length,
    rendered: r.orderStage.renderedCount,
    orphans: r.orderStage.orphanCount,
    aboveDivider: r.orderStage.aboveDividerCount ?? -1,
    belowDivider: r.orderStage.belowDividerCount ?? -1,
    skipped: r.cardStates.skipped,
    viewed: r.cardStates.viewed,
    unviewed: r.cardStates.unviewed,
    staleCardStates: r.cardStates.staleEntries,
    missingFromOrder: r.candidatesNotInOrder.absent,
    missingOpenedByArticleId: r.candidatesNotInOrder.byReason['opened-by-article-id'],
    missingNotYetIngested: r.candidatesNotInOrder.byReason['not-yet-ingested'],
    wouldBeBlockedByClusterGate: r.wouldBeBlockedByClusterGate,
    openedArticleIds: r.opened.articleIdSetSize,
    openedUnionIds: r.opened.unionSetSize,
    openedRows: r.opened.stats?.rowCount ?? -1,
    openedOlderThan7d: r.opened.stats?.ageBuckets.d7to30 ?? -1,
    // Which scorer ran. `-1` (not 0) when the breakdown was unavailable, the
    // same "this is not a measurement" convention the opened fields use above.
    useArticleTags: r.scoring.useArticleTags,
    scoredByMath: r.scoring.available ? r.scoring.math : -1,
    scoredByLlm: r.scoring.available ? r.scoring.legacy : -1,
    scoredByUnknown: r.scoring.available ? r.scoring.unknown : -1,
    // Shared-note COUNTS only. `largestGroup` carries a note and article titles
    // and must never come along — see the array/object prohibition above.
    sharedNoteGroups: r.sharedNotes.available ? r.sharedNotes.sharedNoteGroups : -1,
    rowsSharingANote: r.sharedNotes.available ? r.sharedNotes.rowsSharingANote : -1,
    largestSharedNoteGroup: r.sharedNotes.available ? r.sharedNotes.largestGroupSize : -1,
    orderHydrated: r.hydrated.order,
    openedHydrated: r.hydrated.opened,
    launchWipeSuspected: r.launchWipeSuspected,
    sumsOk:
      r.sumsCheck.visibilityAttributionSums &&
      r.sumsCheck.memberSumMatchesVisible &&
      r.sumsCheck.orderReasonsSum,
  };
}
