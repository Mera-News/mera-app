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
 * IMPORT-CYCLE CONSTRAINT (do not violate): this module imports ONLY DB
 * services, the pure story-grouping/read-filter utilities, and the logger —
 * NEVER scoring-pipeline. The set of in-flight candidate ids is passed IN by
 * callers so we never have to reach back into the pipeline. The `onPropagated`
 * hook below follows the same rule for the same reason (see HARD FILTERS).
 * (`read-story-filter` is inside the line: it reaches only the DB singleton, the
 * story-impression service and the pure story-grouping utility, and has no edge
 * back into scoring.)
 *
 * ALREADY-READ GATE (relevance v3 §3): before any grouping or election,
 * `gateUnscoredForScoring` drops candidates that re-serve a story the user
 * already TAPPED OPEN and writes them terminal `already_read`. Feed-sync
 * hydration screens the same way one step earlier (never inserting the row at
 * all), so why do it twice? Because the two windows differ: a suggestion synced
 * on Monday and still `unscored` on Tuesday was inserted BEFORE the impression
 * existed, and only this gate — which re-derives from ALL unscored rows every
 * pass — will ever see it. Cheapest defense first, backstop second; both are
 * pre-LLM, so every match is also one scoring pass saved.
 *
 * HARD FILTERS (P9): propagation is DELIBERATELY DUMB about "not interested"
 * filters, and that is a hole unless callers close it. A propagated row is
 * written straight to terminal `complete` with the donor's relevance — it never
 * enters computeMathStage/computeAndJudge, which is where the hard screen
 * (`screenHardSuppressions`) runs. So a newly-synced article that a hard filter
 * blocks can inherit a passing score from a sibling and render.
 *
 * We do NOT screen here: the rows this module handles are
 * `SuggestionGroupingRow`s, which carry no description, entities, category,
 * publicationName, geoTags or matchedTopics — the kind-aware matcher needs all
 * of those. Widening the row type would drag the scoring stack across the
 * import-cycle line above and, worse, invite a SECOND matcher. Instead the
 * CALLERS reconcile, always through `lib/services/suppression-sweep` — the same
 * matcher, the same exclusion, the same feed eviction the retroactive sweep
 * already uses. EVERY call site that can write a propagated score must do it.
 *
 * The two entry points hand callers different handles, which is deliberate:
 *   - `propagateToUnscoredSiblings` takes an optional `onPropagated(ids)` hook
 *     and invokes it with EXACTLY the ids it wrote, so its callers reconcile the
 *     cheap scoped way (`purgeHardFilteredByIds`).
 *   - `gateUnscoredForScoring` reports only a COUNT. Its result shape and its
 *     two-argument call signature are both pinned by existing contract, so it
 *     cannot grow an id list or a hook without breaking callers' tests. Its
 *     callers therefore run the FULL `purgeHardFilteredSuggestions()` sweep when
 *     `propagatedCount > 0`. Do not "optimise" that into the chunk's hydrated
 *     ids: the gate propagates over ALL unscored rows, including ones hydrated
 *     by an earlier chunk or left unscored by an earlier sync, so a chunk's ids
 *     are NOT a superset of what it wrote.
 * Neither entry point reaches into the sweep itself — that would breach the
 * import-cycle rule above.
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
    type PropagateEntry,
} from '@/lib/database/services/article-suggestion-service';
import {
    repPriorityTier,
    type UserGeoLanguageContext,
} from '@/lib/feed-grouping/geo-language-priority';
import {
    batchMarkAlreadyRead,
    loadReadStoryIndex,
    matchesReadStory,
    type ReadStoryIndex,
} from '@/lib/feed-grouping/read-story-filter';
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
    /**
     * Elected rep id → EVERY candidate id in that rep's group, the rep included
     * (so always non-empty, and `[id]` for a donor-less singleton). Keyed only by
     * ids that appear in `enqueueIds`; donor groups contribute nothing since they
     * are propagated, never enqueued.
     *
     * This is the ENQUEUE side of the gate, not the propagated set — the
     * HARD FILTERS note above (which pins `propagatedCount` to a count) is about
     * ids the gate WROTE and is untouched by this. The scoring pipeline persists
     * the union of these sets per batch so the "Analysing X of Y articles" header
     * can count the articles a run really covers — a representative plus the
     * siblings that will inherit its score — instead of the representatives
     * alone, which undercounts by the duplicate factor of the feed.
     */
    coveredIdsByRep: Record<string, string[]>;
    /**
     * How many candidates were dropped as ALREADY READ and written terminal
     * `already_read` (see the gate note at the top). Purely observational — the
     * ids are gone from `enqueueIds`/`coveredIdsByRep` by the time this is
     * reported, so no caller has to act on it. Additive: existing consumers that
     * destructure the four original fields are unaffected.
     */
    readCount: number;
}

/**
 * Test one grouping row against the read index. A row's WMDB `id` IS the server
 * article id (`persistAndLinkV2Suggestions` sets `_raw.id = a._id`), so it feeds
 * the article-id axis directly.
 *
 * Every membership's `stableClusterId` is offered, UNGATED by confidence, and the
 * asymmetry with `PROPAGATION_OPTIONS` below is deliberate. There the gate exists
 * because a fringe member must not INHERIT a stranger's verdict; here the id came
 * from the user's own read — `use-open-suggestion` snapshots
 * `clusters.find(c => c.stableClusterId)` with no confidence test — so gating
 * would just mean failing to recognise the very story they opened.
 */
function readCandidateOf(row: SuggestionGroupingRow): {
    articleId: string;
    stableClusterId: string | null;
    title: string | null;
} {
    let stableClusterId: string | null = null;
    for (const m of row.clusters ?? []) {
        if (m?.stableClusterId) {
            stableClusterId = m.stableClusterId;
            break;
        }
    }
    return { articleId: row.id, stableClusterId, title: row.title };
}

/**
 * Split candidates into "already read" and "still scorable". Pure; the caller
 * owns the write. Returns the input untouched when the index is inert, so the
 * no-reads case costs one integer comparison.
 */
function partitionAlreadyRead(
    candidates: SuggestionGroupingRow[],
    index: ReadStoryIndex,
): { alreadyReadIds: string[]; scorable: SuggestionGroupingRow[] } {
    if (index.impressionCount === 0) return { alreadyReadIds: [], scorable: candidates };
    const alreadyReadIds: string[] = [];
    const scorable: SuggestionGroupingRow[] = [];
    for (const c of candidates) {
        if (matchesReadStory(readCandidateOf(c), index)) alreadyReadIds.push(c.id);
        else scorable.push(c);
    }
    return { alreadyReadIds, scorable };
}

/**
 * Reconcile hook, invoked with exactly the ids that just inherited a score.
 * Supplied by callers (never imported here — see the IMPORT-CYCLE + HARD FILTERS
 * notes at the top). Its own failure must not fail the propagation, which has
 * already been committed, so it is invoked inside its own try/catch.
 */
export type OnPropagated = (ids: string[]) => Promise<unknown>;

/** Run the caller's reconcile hook over freshly-propagated ids. Isolated from
 *  the propagation's own fail-open handler so the two failures stay
 *  distinguishable in Sentry: a reconcile failure means a hard-filtered row may
 *  be renderable until the next filter mutation sweep, which is worth its own
 *  tag. */
async function runOnPropagated(
    ids: string[],
    onPropagated: OnPropagated | undefined,
): Promise<void> {
    if (!onPropagated || ids.length === 0) return;
    try {
        await onPropagated(ids);
    } catch (err) {
        logger.captureException(err, {
            tags: { module: 'score-propagation', step: 'reconcile-hard-filters' },
        });
    }
}

// Propagation deliberately omits BOTH opt-in DISPLAY edges — the IDF-weighted
// title edge (no `weightedJaccardThreshold`) and the entity-overlap edge (no
// `entityJaccardThreshold`) — keeping the stricter cluster + raw-title signals
// only. The asymmetry is the point: a wrong DISPLAY merge only hides a card
// behind a "+N sources" badge, whereas a wrong PROPAGATION merge copies an LLM
// relevance verdict (and its reason string) onto an unrelated article, which
// mis-ranks or silently hides it. Two articles about the same two organisations
// on the same day are a plausible enough display collapse and a bad enough score
// donor that the two layers must not share a bar. Do not "unify" these options.
//
// The stable-cluster edge (same non-null `stableClusterId`) is always on inside
// `buildStoryGroups`, so propagation gets it for free — but propagation keeps its
// membership-confidence GATE, by NOT passing `ungateStableClusterEdge`. Display
// dropped that gate on 2026-07-31 (see the edge-0 note in `story-grouping.ts`);
// propagation deliberately did not. A stable id is high-precision about which
// story a cluster is, but adds nothing about whether a `confidence = 1e-38`
// fringe article really belongs to it — and that is precisely the article you
// must not hand someone else's relevance verdict to. Same asymmetry as the two
// display edges above. Do not "unify" these options.
const PROPAGATION_OPTIONS = {
    titleJaccardThreshold: TITLE_JACCARD_PROPAGATION_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
} as const;

/**
 * Pick the donor whose score should propagate to a group's candidates: a donor
 * that actually HAS a reason first, then highest relevance, tie-broken by newest
 * `firstPubDateMs`, then (via pickRepresentative) the lexicographically smaller
 * id. Biasing up on ties fails open — worst case a slight over-rank, never a
 * silently hidden story.
 *
 * `hasReason` leads because a reason-less donor donates `''`, which leaves the
 * candidate in `reason_pending` still owing its own LLM reason call (see
 * `batchPropagateScores`, which no longer stamps `complete` on an empty copy).
 * When ANY donor in the group carries a reason, taking that one lands the
 * candidate on `complete` for free.
 *
 * This only REORDERS donors that were already eligible — it never shrinks the
 * donor pool. That distinction matters: donors are grouping INPUT
 * (`buildStoryGroups([...donors, ...candidates])`), not a lookup table, so
 * dropping one could split a group that only cohered through it and cause the
 * same story to be scored twice. Reordering cannot.
 */
function pickDonor(donors: SuggestionGroupingRow[]): SuggestionGroupingRow {
    return pickRepresentative(donors, (a, b) => {
        // 0 = has a reason, 1 = none. Lower sorts first.
        const aNoReason = (a.reason ?? '').trim().length > 0 ? 0 : 1;
        const bNoReason = (b.reason ?? '').trim().length > 0 ? 0 : 1;
        if (aNoReason !== bNoReason) return aNoReason - bNoReason; // has-reason first
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
        const allCandidates = (await getUnscoredGroupingRows()).filter(
            (r) => !inFlightIds.has(r.id),
        );
        candidateIds = allCandidates.map((c) => c.id);
        if (allCandidates.length === 0) {
            return {
                enqueueIds: [],
                propagatedCount: 0,
                heldBackCount: 0,
                coveredIdsByRep: {},
                readCount: 0,
            };
        }

        // ALREADY-READ GATE — runs BEFORE grouping/election so a read story can
        // neither be enqueued nor be elected representative for siblings that are
        // NOT read (which would have handed the whole group a verdict derived
        // from an article the user is done with). `loadReadStoryIndex` fails open
        // to an inert index, so a read failure degrades to the previous behaviour
        // rather than hiding anything.
        const readIndex = await loadReadStoryIndex();
        const { alreadyReadIds, scorable: candidates } = partitionAlreadyRead(
            allCandidates,
            readIndex,
        );
        if (alreadyReadIds.length > 0) {
            await batchMarkAlreadyRead(alreadyReadIds);
            // Re-point the fail-open set at what survived: rows just written
            // terminal must never be enqueued by a later step's catch.
            candidateIds = candidates.map((c) => c.id);
        }
        if (candidates.length === 0) {
            return {
                enqueueIds: [],
                propagatedCount: 0,
                heldBackCount: 0,
                coveredIdsByRep: {},
                readCount: alreadyReadIds.length,
            };
        }

        const donors = await getScoredDonorRows(Date.now() - SCORE_PROPAGATION_LOOKBACK_MS);
        // Donor rows are never unscored, so they never overlap the candidate set;
        // a Set of their ids lets us split each group in O(1).
        const donorIds = new Set(donors.map((d) => d.id));

        const groups = buildStoryGroups<SuggestionGroupingRow>(
            [...donors, ...candidates],
            PROPAGATION_OPTIONS,
        );

        const propagateEntries: PropagateEntry[] = [];
        const enqueueIds: string[] = [];
        const coveredIdsByRep: Record<string, string[]> = {};
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
                        // The VINTAGE travels with the score, not with the row.
                        // The recipient never ran a scorer; it is inheriting the
                        // donor's number, so it must be judged at the gate that
                        // number was calibrated for. Reading the recipient's own
                        // (absent) vintage here would gate a v3 score at 0.4.
                        scoredWithV3: donor.scoredWithV3 ?? null,
                    });
                }
            } else if (groupCandidates.length >= 2) {
                // Same-sync election: score one, hold the siblings back. The rep
                // COVERS the whole group — the siblings inherit its score rather
                // than earning their own — so report the membership for the
                // pipeline's article-coverage counter.
                const repId = electRepresentative(groupCandidates, userCtx).id;
                enqueueIds.push(repId);
                coveredIdsByRep[repId] = groupCandidates.map((c) => c.id);
                heldBackCount += groupCandidates.length - 1;
            } else {
                // Donor-less singleton → score it directly, covering only itself.
                const soloId = groupCandidates[0].id;
                enqueueIds.push(soloId);
                coveredIdsByRep[soloId] = [soloId];
            }
        }

        if (propagateEntries.length > 0) {
            await batchPropagateScores(propagateEntries);
        }

        console.log(
            `[score-propagation] propagated ${propagateEntries.length}, held back ${heldBackCount}, enqueue ${enqueueIds.length}, read ${alreadyReadIds.length}`,
        );
        return {
            enqueueIds,
            propagatedCount: propagateEntries.length,
            heldBackCount,
            coveredIdsByRep,
            readCount: alreadyReadIds.length,
        };
    } catch (err) {
        logger.captureException(err, { tags: { module: 'score-propagation' } });
        // Fail open: enqueue every candidate we knew about, propagate nothing.
        // No election happened, so every id covers exactly itself. `candidateIds`
        // already excludes anything the already-read gate wrote terminal, so this
        // path cannot resurrect a read story.
        const coveredIdsByRep: Record<string, string[]> = {};
        for (const id of candidateIds) coveredIdsByRep[id] = [id];
        return {
            enqueueIds: candidateIds,
            propagatedCount: 0,
            heldBackCount: 0,
            coveredIdsByRep,
            readCount: 0,
        };
    }
}

/**
 * Post-results propagation: after relevance results are saved, copy fresh donors'
 * scores onto any remaining unscored siblings. Same grouping as the gate but ONLY
 * the propagation step (no election, no enqueue). Returns the number of rows that
 * inherited a score. Fails open to 0.
 *
 * `onPropagated` is the hard-filter reconcile hook (see HARD FILTERS at the top)
 * — pass it from every call site.
 */
export async function propagateToUnscoredSiblings(
    inFlightIds: Set<string>,
    onPropagated?: OnPropagated,
): Promise<number> {
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

        const propagateEntries: PropagateEntry[] = [];
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
                    // See the note at the other push site: the gate follows the
                    // score's scorer, and the score here is the donor's.
                    scoredWithV3: donor.scoredWithV3 ?? null,
                });
            }
        }

        if (propagateEntries.length > 0) {
            await batchPropagateScores(propagateEntries);
            await runOnPropagated(
                propagateEntries.map((e) => e.id),
                onPropagated,
            );
            console.log(`[score-propagation] sibling propagation: ${propagateEntries.length}`);
        }
        return propagateEntries.length;
    } catch (err) {
        logger.captureException(err, { tags: { module: 'score-propagation' } });
        return 0;
    }
}
