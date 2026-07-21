/**
 * Scoring skip gate + same-sync election + post-results sibling propagation.
 *
 * These two entry points sit between feed-sync's "collect eligible unscored ids"
 * step and the scoring pipeline's `enqueueCandidates`, and between the pipeline's
 * relevance-result save and its store refresh. Both exploit the story-grouping
 * utility: the server's HDBSCAN clustering wipes and re-inserts cluster ids every
 * run, so the same story appears many times across sync generations. Rather than
 * scoring every duplicate, we:
 *   (a) copy an already-scored "donor" story's relevance/reason onto its still
 *       unscored siblings (the skip gate + the post-results hook), and
 *   (b) among a batch of same-sync duplicates with no donor yet, score only ONE
 *       elected representative and hold its siblings back until its score lands.
 *
 * IMPORT-CYCLE CONSTRAINT (do not violate): this module imports ONLY the DB
 * service, the pure story-grouping utility, and the logger — NEVER
 * scoring-pipeline. The set of in-flight candidate ids is passed IN by callers
 * so we never have to reach back into the pipeline.
 *
 * STATELESS + SELF-HEALING: nothing about "held back" is persisted anywhere.
 * Candidates are recomputed each call as ALL unscored rows minus the in-flight
 * set, so a sibling missed by a failed batch or an app kill is simply
 * re-considered on the next sync (propagated if its representative scored,
 * re-enqueued otherwise). There is no starvation and no bookkeeping to corrupt.
 *
 * NEVER deletes rows. A donor with relevance ≤ 0.3 still propagates — the
 * candidate simply becomes the same hidden low-relevance tombstone shape the UI
 * already filters out (row kept so the sync diff never re-downloads it).
 */

import {
    batchPropagateScores,
    getScoredDonorRows,
    getUnscoredGroupingRows,
    type SuggestionGroupingRow,
} from '@/lib/database/services/article-suggestion-service';
import {
    repPriorityTier,
    type UserGeoLanguageContext,
} from '@/lib/feed-grouping/geo-language-priority';
import {
    buildStoryGroups,
    pickRepresentative,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    SCORE_PROPAGATION_LOOKBACK_MS,
    TITLE_JACCARD_PROPAGATION_THRESHOLD,
} from '@/lib/feed-grouping/story-grouping';
import logger from '@/lib/logger';

export interface GateResult {
    /** Ids to hand to `enqueueCandidates` (donor-less singletons + one elected
     *  representative per same-sync duplicate group). */
    enqueueIds: string[];
    /** How many candidates inherited a donor's score (written to the DB). */
    propagatedCount: number;
    /** How many same-sync duplicate siblings were held back (not enqueued, no
     *  state written — picked up next sync or by the post-results hook). */
    heldBackCount: number;
}

// Propagation deliberately omits the IDF-weighted title edge (no
// `weightedJaccardThreshold`) — a wrong score copy mis-ranks/hides an article,
// so it keeps the stricter cluster + raw-title signals only. The stable-cluster
// edge (same non-null `stableClusterId`) is NOT an option — it is always on
// inside `buildStoryGroups`, so propagation gets it for free, including its
// membership-confidence gate (the stable edge only counts memberships whose
// confidence ≥ `clusterConfidenceThreshold`, i.e. the same 0.3 bar passed
// below — the < 0.3 fringe stays excluded from propagation too). That is correct
// and intended: a shared stable id means the same cross-run story, exactly the
// same-story guarantee the existing same-cluster propagation already relies on,
// so copying a donor's relevance/reason across it is sound (not merely cosmetic).
const PROPAGATION_OPTIONS = {
    titleJaccardThreshold: TITLE_JACCARD_PROPAGATION_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
} as const;

/**
 * Pick the donor whose score should propagate to a group's candidates:
 * highest relevance, tie-broken by newest `firstPubDateMs`, then (via
 * pickRepresentative) the lexicographically smaller id. Biasing up on ties fails
 * open — worst case a slight over-rank, never a silently hidden story.
 */
function pickDonor(donors: SuggestionGroupingRow[]): SuggestionGroupingRow {
    return pickRepresentative(donors, (a, b) => {
        if (a.relevance !== b.relevance) return b.relevance - a.relevance; // higher first
        if (a.firstPubDateMs !== b.firstPubDateMs) return b.firstPubDateMs - a.firstPubDateMs; // newer first
        return 0; // id tiebreak handled by pickRepresentative
    });
}

/**
 * Elect the single representative to score for a donor-less duplicate group.
 *
 * Country/language priority comes FIRST: a lower `repPriorityTier` wins (an
 * article from the user's HOME country → another of the user's countries → the
 * user's app-UI language → the rest). Only when two candidates share a tier do
 * the legacy tiebreaks decide: prefer a row that has a description, then newest
 * `firstPubDateMs`, then (via pickRepresentative) the smaller id. A `null`
 * `userCtx` collapses every tier to 3, so election degrades to the exact legacy
 * order. Fully deterministic.
 */
function electRepresentative(
    candidates: SuggestionGroupingRow[],
    userCtx: UserGeoLanguageContext | null,
): SuggestionGroupingRow {
    // Groups are small, so computing the tier inline in the comparator is fine.
    return pickRepresentative(candidates, (a, b) => {
        const tierA = repPriorityTier(
            { countryCodeAlpha3: a.countryCode, languageCode: a.languageCode },
            userCtx,
        );
        const tierB = repPriorityTier(
            { countryCodeAlpha3: b.countryCode, languageCode: b.languageCode },
            userCtx,
        );
        if (tierA !== tierB) return tierA - tierB; // lower tier = higher priority
        if (a.hasDescription !== b.hasDescription) return a.hasDescription ? -1 : 1;
        if (a.firstPubDateMs !== b.firstPubDateMs) return b.firstPubDateMs - a.firstPubDateMs;
        return 0;
    });
}

/**
 * Skip gate + same-sync election, run before `enqueueCandidates`.
 *
 * Candidates = ALL unscored rows minus `inFlightIds`; donors = rows scored in the
 * last 48h. We group `[...donors, ...candidates]` at the (stricter) propagation
 * thresholds, then per group:
 *   - ≥1 donor + ≥1 candidate → propagate the best donor's score to every
 *     candidate (one accumulated batch write across all groups);
 *   - donor-less, ≥2 candidates → elect one representative to enqueue (via
 *     `electRepresentative`, honoring `userCtx`'s country/language priority),
 *     hold the rest back;
 *   - donor-less singleton → enqueue.
 *
 * `userCtx` (default `null`) is the user's geo/language context, threaded in by
 * the caller so this module stays store/DB-decoupled. A `null` context makes
 * election byte-identical to the legacy (country/language-blind) order.
 *
 * Fails open: on any error, enqueue all candidate ids and propagate nothing.
 */
export async function gateUnscoredForScoring(
    inFlightIds: Set<string>,
    userCtx: UserGeoLanguageContext | null = null,
): Promise<GateResult> {
    // Captured before any throwing step so the fail-open path can enqueue them.
    let candidateIds: string[] = [];
    try {
        const candidates = (await getUnscoredGroupingRows()).filter((r) => !inFlightIds.has(r.id));
        candidateIds = candidates.map((c) => c.id);
        if (candidates.length === 0) {
            return { enqueueIds: [], propagatedCount: 0, heldBackCount: 0 };
        }

        const donors = await getScoredDonorRows(Date.now() - SCORE_PROPAGATION_LOOKBACK_MS);
        // Donor rows are never unscored, so they never overlap the candidate set;
        // a Set of their ids lets us split each group in O(1).
        const donorIds = new Set(donors.map((d) => d.id));

        const groups = buildStoryGroups<SuggestionGroupingRow>(
            [...donors, ...candidates],
            PROPAGATION_OPTIONS,
        );

        const propagateEntries: { id: string; relevance: number; reason: string }[] = [];
        const enqueueIds: string[] = [];
        let heldBackCount = 0;

        for (const group of groups) {
            const groupCandidates = group.filter((r) => !donorIds.has(r.id));
            if (groupCandidates.length === 0) continue; // donor-only group — nothing to do

            const groupDonors = group.filter((r) => donorIds.has(r.id));
            if (groupDonors.length > 0) {
                // Propagation: every candidate inherits the best donor's score.
                const donor = pickDonor(groupDonors);
                for (const c of groupCandidates) {
                    propagateEntries.push({
                        id: c.id,
                        relevance: donor.relevance,
                        reason: donor.reason,
                    });
                }
            } else if (groupCandidates.length >= 2) {
                // Same-sync election: score one, hold the siblings back.
                enqueueIds.push(electRepresentative(groupCandidates, userCtx).id);
                heldBackCount += groupCandidates.length - 1;
            } else {
                // Donor-less singleton → score it directly.
                enqueueIds.push(groupCandidates[0].id);
            }
        }

        if (propagateEntries.length > 0) {
            await batchPropagateScores(propagateEntries);
        }

        console.log(
            `[score-propagation] propagated ${propagateEntries.length}, held back ${heldBackCount}, enqueue ${enqueueIds.length}`,
        );
        return { enqueueIds, propagatedCount: propagateEntries.length, heldBackCount };
    } catch (err) {
        logger.captureException(err, { tags: { module: 'score-propagation' } });
        // Fail open: enqueue every candidate we knew about, propagate nothing.
        return { enqueueIds: candidateIds, propagatedCount: 0, heldBackCount: 0 };
    }
}

/**
 * Post-results propagation: after relevance results are saved, copy fresh donors'
 * scores onto any remaining unscored siblings. Same grouping as the gate but ONLY
 * the propagation step (no election, no enqueue). Returns the number of rows that
 * inherited a score. Fails open to 0.
 */
export async function propagateToUnscoredSiblings(inFlightIds: Set<string>): Promise<number> {
    try {
        const candidates = (await getUnscoredGroupingRows()).filter((r) => !inFlightIds.has(r.id));
        if (candidates.length === 0) return 0;

        const donors = await getScoredDonorRows(Date.now() - SCORE_PROPAGATION_LOOKBACK_MS);
        if (donors.length === 0) return 0;
        const donorIds = new Set(donors.map((d) => d.id));

        const groups = buildStoryGroups<SuggestionGroupingRow>(
            [...donors, ...candidates],
            PROPAGATION_OPTIONS,
        );

        const propagateEntries: { id: string; relevance: number; reason: string }[] = [];
        for (const group of groups) {
            const groupDonors = group.filter((r) => donorIds.has(r.id));
            if (groupDonors.length === 0) continue;
            const groupCandidates = group.filter((r) => !donorIds.has(r.id));
            if (groupCandidates.length === 0) continue;
            const donor = pickDonor(groupDonors);
            for (const c of groupCandidates) {
                propagateEntries.push({
                    id: c.id,
                    relevance: donor.relevance,
                    reason: donor.reason,
                });
            }
        }

        if (propagateEntries.length > 0) {
            await batchPropagateScores(propagateEntries);
            console.log(`[score-propagation] sibling propagation: ${propagateEntries.length}`);
        }
        return propagateEntries.length;
    } catch (err) {
        logger.captureException(err, { tags: { module: 'score-propagation' } });
        return 0;
    }
}
