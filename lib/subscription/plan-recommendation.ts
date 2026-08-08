// Plan recommendation for the paywall's usage card — a personalized line
// alongside (not replacing) the day-one static copy for a thin-history user.
//
// Deliberately DOES NOT invent a conversion between "articles opened" and
// "articles analyzed" — `publication_visits` (one row per "Read Article" tap,
// never wiped, keyed by article_id — see
// `lib/database/services/publication-visit-service.ts`) measures READING.
// `dailyArticleLimit` measures the AI *analysis* quota. They are different
// things, so the recommendation states both, e.g.:
//   "You open about {{count}} articles a day. {{plan}} analyzes up to
//    {{limit}} a day so there is always more than you'll get through."
//
// Pure — no React Native, no network, no WatermelonDB import. `plans` and
// `now` are both caller-supplied so every boundary is a one-line test:
//   - `plans` because there is no client-side catalogue of per-tier
//     `dailyArticleLimit` today. `UserBilling.dailyArticleLimit` (see
///    lib/billing-service.ts) is the CURRENT user's own limit — a paywall
//     visitor, by definition, has none yet. Wiring this into a live plan
//     list is a follow-up with its own data source, not something to
//     fabricate here.
//   - `now` so "exactly 14 days" and "exactly 5 visits" are deterministic.

/** One purchasable tier, as much as this module needs to know about it. */
export interface RecommendationPlan {
    id: string;
    name: string;
    /** The AI analysis quota for this tier (`UserBilling.dailyArticleLimit`'s shape). */
    dailyArticleLimit: number;
}

/** The minimal shape of a `publication_visits` row this module reads. */
export interface RecommendationVisit {
    /** Epoch ms — `PublicationVisit.visitedAt` (or `VisitedArticle.visitedAt`). */
    visitedAt: number;
}

export interface PlanRecommendation {
    plan: RecommendationPlan;
    /** Average articles opened per day over the trailing 14-day window. */
    avgDaily: number;
}

const MIN_HISTORY_DAYS = 14;
const MIN_HISTORY_MS = MIN_HISTORY_DAYS * 24 * 60 * 60 * 1000;
const MIN_TOTAL_VISITS = 5;
/** Headroom multiplier: the recommended plan's limit must comfortably clear
 *  what the user actually reads, not just match it. */
const HEADROOM_MULTIPLIER = 3;

/**
 * Recommends the cheapest plan whose `dailyArticleLimit` comfortably covers
 * this device's recent reading pace, or `null` when there isn't enough
 * history yet to say anything meaningful.
 *
 * - `null` when `visits.length < 5` (a recommendation built on three taps is
 *   noise — the existing day-one copy shows instead) OR when the visit
 *   history doesn't yet span a full 14 days (`now - earliestVisit < 14d`).
 *   Both boundaries are inclusive: exactly 5 visits and exactly 14 days of
 *   span both PASS.
 * - `avgDaily` is visits whose `visitedAt` falls in the trailing 14-day
 *   window `[now - 14d, now]`, divided by the FIXED denominator 14 (not by
 *   however many distinct days were actually observed) — re-opening an old
 *   article moves its row's timestamp forward, so the window is read off
 *   whatever timestamps currently survive, deliberately.
 * - `plans` must be given cheapest-first (ascending price). The first plan
 *   whose `dailyArticleLimit >= avgDaily * 3` is picked.
 * - When NO plan clears that bar (a very heavy reader), the recommendation
 *   falls back to the most generous plan on offer (highest
 *   `dailyArticleLimit`) rather than returning `null` — the copy's promise
 *   ("there is always more than you'll get through") is the anchor, so the
 *   card always names the plan closest to keeping it, never nothing.
 * - `null` when `plans` is empty — there is nothing to recommend.
 */
export function recommendPlan(
    visits: RecommendationVisit[],
    plans: RecommendationPlan[],
    now: number = Date.now(),
): PlanRecommendation | null {
    if (visits.length < MIN_TOTAL_VISITS) return null;
    if (plans.length === 0) return null;

    const earliestVisitedAt = visits.reduce(
        (earliest, v) => Math.min(earliest, v.visitedAt),
        Infinity,
    );
    if (now - earliestVisitedAt < MIN_HISTORY_MS) return null;

    const windowStart = now - MIN_HISTORY_MS;
    const recentCount = visits.filter(
        (v) => v.visitedAt >= windowStart && v.visitedAt <= now,
    ).length;
    const avgDaily = recentCount / MIN_HISTORY_DAYS;

    const threshold = avgDaily * HEADROOM_MULTIPLIER;
    const qualifying = plans.find((p) => p.dailyArticleLimit >= threshold);
    const plan =
        qualifying ??
        plans.reduce((mostGenerous, p) =>
            p.dailyArticleLimit > mostGenerous.dailyArticleLimit ? p : mostGenerous,
        );

    return { plan, avgDaily };
}
