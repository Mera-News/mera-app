/**
 * Already-READ story exclusion — the pre-scoring gate (relevance v3 §3).
 *
 * THE PROBLEM (user report, corroborated on a live device 2026-08-05): stories
 * the user already TAPPED OPEN keep coming back into the feed. Today's only
 * defense is the `P_SEEN = 0.08` scoring demotion, which is cosmetic (it moves a
 * card down, it does not remove it) AND is keyed on signals that mostly do not
 * exist by the time they are needed:
 *
 *   - only 28 of 51 opened `story_impressions` carried a `stable_cluster_id` at
 *     all, so the cluster axis is blind on ~45% of reads;
 *   - the cluster ids that ARE stored drift across days (the known HDBSCAN
 *     shattering — the server re-mints per run and the cross-run `stableClusterId`
 *     only exists for multi-member clusters that survived overlap matching), so
 *     cluster-id matching caught ZERO re-serves in the frozen-DB replay;
 *   - `seenPenalty` fired on 1 of 324 scored rows.
 *
 * THE ROBUST KEY IS THE STORED `title_norm`. Every opened impression snapshots
 * the English headline at read time (`story-impression-service::recordOpen`,
 * lowercased + whitespace-collapsed) precisely so a re-serve of the SAME story
 * under a different article id / cluster generation can still be recognised. So
 * this module matches on the UNION of three keys, cheapest first:
 *
 *   1. `article_id` equality — the exact same article came back.
 *   2. `stable_cluster_id` equality — kept because when it IS present it is
 *      free and authoritative; it is simply not sufficient on its own.
 *   3. normalized-title Jaccard ≥ 0.55 — the load-bearing signal.
 *
 * WHY 0.55, AND WHY IT MUST STAY THE PROPAGATION CONSTANT. 0.55 is
 * `TITLE_JACCARD_PROPAGATION_THRESHOLD`, IMPORTED (never re-declared) from
 * `story-grouping.ts`, along with that module's `normalizeTitleTokens` +
 * `titleJaccard`. Both gates answer the same question — "is this the same story
 * as one I already have a verdict for?" — and both pay the same price for a
 * false positive: propagation copies someone else's relevance onto an unrelated
 * article, this gate deletes an unrelated article from the feed outright. The
 * bar was calibrated for exactly that severity (within-group relevance agreed
 * within 0.2 in 80/92 groups at 0.55), so the two must not drift apart.
 *
 * THE BOUNDARY THAT MATTERS: a genuinely NEW DEVELOPMENT in a story the user
 * already read gets a NEW HEADLINE, whose token set diverges well below 0.55, so
 * it does NOT match and still reaches the feed. That is the whole reason this is
 * a title-similarity gate and not a topic/cluster gate — the user asked to stop
 * seeing what they read, not to stop following what they read about.
 *
 * SCOPE: opened impressions ONLY (`opened === true`), inside their existing 30-day
 * TTL (`story-impression-service::deleteOlderThan`, run by the data-cleanup task).
 * A mere scroll-past impression is NOT a read — see the OPENS-ONLY note in that
 * service. No new TTL, no new table, no schema change: the `already_read` status
 * is a new VALUE in an existing text column.
 *
 * FAIL-OPEN EVERYWHERE. Any failure to build the index yields the EMPTY index,
 * which matches nothing — a broken read-filter must show the user too much, never
 * too little.
 */

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import {
    normalizeTitleTokens,
    titleJaccard,
    TITLE_JACCARD_PROPAGATION_THRESHOLD,
} from '@/lib/feed-grouping/story-grouping';
import logger from '@/lib/logger';

// STATIC GRAPH IS DELIBERATELY PURE: the two database touch-points below use
// lazy `require`s (the same pattern as feed-sync-steps::reconcileHardFilters and
// lib/database/hydrate-stores.ts). `@/lib/database` instantiates a SQLiteAdapter
// AT IMPORT — it is excluded from coverage for exactly that reason — and
// `story-impression-service` captures a collection handle at import, so a static
// import here would drag the native singleton into every module that merely
// wants to MATCH (score-propagation, feed-sync-steps, and every suite that
// imports them). Keeping it lazy means the pure half of this module — which is
// all any caller needs to reason about — costs nothing to import.

/**
 * Title-similarity bar for "I already read this". Deliberately an ALIAS of the
 * propagation threshold rather than an independent number — see the module note.
 * Re-exported so call sites and tests can name the bar without reaching past this
 * module into story-grouping.
 */
export const READ_STORY_TITLE_JACCARD_THRESHOLD = TITLE_JACCARD_PROPAGATION_THRESHOLD;

/** The subset of a `story_impressions` row this gate reads. Structural, not the
 *  WatermelonDB model, so the pure builder is testable without a database. */
export interface ReadStoryImpressionRow {
    articleId?: string | null;
    stableClusterId?: string | null;
    /** Snapshot of the English headline at read time (already lowercased +
     *  whitespace-collapsed by `recordOpen`). Re-normalized here anyway —
     *  `normalizeTitleTokens` is idempotent over that shape. */
    titleNorm?: string | null;
    /** Only `true` counts. See the OPENS-ONLY scope note above. */
    opened?: boolean | null;
}

/** What a candidate must expose to be tested against the index. Every field is
 *  optional: a candidate that carries only a title is still matchable, and one
 *  that carries nothing simply never matches. */
export interface ReadStoryCandidate {
    /** Server article id. NOTE: for `article_suggestions` the WatermelonDB row
     *  `id` IS the server `_id` (see `persistAndLinkV2Suggestions`, which sets
     *  `_raw.id = a._id`), so a suggestion's row id is a valid value here. */
    articleId?: string | null;
    stableClusterId?: string | null;
    /** English title (`title_en`) or an already-normalized `title_norm`. */
    title?: string | null;
}

export interface ReadStoryIndex {
    /** Article ids of opened impressions. */
    articleIds: Set<string>;
    /** Non-null stable cluster ids of opened impressions. */
    stableClusterIds: Set<string>;
    /** Token set per opened impression that had a usable `title_norm`. */
    titleTokenSets: Set<string>[];
    /** token → indices into `titleTokenSets`. Pure BLOCKING, and exact: any pair
     *  with Jaccard > 0 shares at least one token, so a candidate that shares no
     *  token with an entry cannot possibly clear 0.55. Unlike story-grouping's
     *  blocking there is no hot-token skip and no min-shared-token rule — this
     *  index is small (bounded by 30 days of reads) and correctness beats the
     *  micro-optimisation. */
    titlePostings: Map<string, number[]>;
    /** How many opened impressions were folded in. 0 ⇒ the gate is inert. */
    impressionCount: number;
}

/** The index that matches nothing. Returned by every fail-open path. */
export const EMPTY_READ_STORY_INDEX: ReadStoryIndex = {
    articleIds: new Set(),
    stableClusterIds: new Set(),
    titleTokenSets: [],
    titlePostings: new Map(),
    impressionCount: 0,
};

/**
 * Fold opened impressions into a match index. PURE — no DB, no logger, never
 * throws.
 *
 * The `opened === true` guard lives HERE (mirroring
 * `story-impression-service::getOpenedSeenBreakdown`, which keeps its own guard
 * in the shared builder for the same reason): legacy `opened=false` rows are
 * still on-device until they TTL out, and a scroll-past must never exclude a
 * story from the feed.
 */
export function buildReadStoryIndex(rows: ReadStoryImpressionRow[]): ReadStoryIndex {
    const articleIds = new Set<string>();
    const stableClusterIds = new Set<string>();
    const titleTokenSets: Set<string>[] = [];
    const titlePostings = new Map<string, number[]>();
    let impressionCount = 0;

    for (const row of rows ?? []) {
        if (!row || row.opened !== true) continue;
        impressionCount += 1;

        const articleId = (row.articleId ?? '').trim();
        if (articleId) articleIds.add(articleId);

        const stableClusterId = (row.stableClusterId ?? '').trim();
        if (stableClusterId) stableClusterIds.add(stableClusterId);

        const tokens = normalizeTitleTokens(row.titleNorm);
        if (tokens.size === 0) continue; // no title evidence — the id axes still apply
        const idx = titleTokenSets.length;
        titleTokenSets.push(tokens);
        for (const token of tokens) {
            const posting = titlePostings.get(token);
            if (posting) posting.push(idx);
            else titlePostings.set(token, [idx]);
        }
    }

    return { articleIds, stableClusterIds, titleTokenSets, titlePostings, impressionCount };
}

/**
 * Does this candidate re-serve a story the user already read? PURE, never throws.
 *
 * Cheapest axis first (two set lookups) before any tokenization, because the
 * common case on a full sync is "no match" over hundreds of candidates.
 */
export function matchesReadStory(
    candidate: ReadStoryCandidate,
    index: ReadStoryIndex,
): boolean {
    if (!candidate || !index || index.impressionCount === 0) return false;

    const articleId = (candidate.articleId ?? '').trim();
    if (articleId && index.articleIds.has(articleId)) return true;

    const stableClusterId = (candidate.stableClusterId ?? '').trim();
    if (stableClusterId && index.stableClusterIds.has(stableClusterId)) return true;

    const tokens = normalizeTitleTokens(candidate.title);
    if (tokens.size === 0) return false;

    const considered = new Set<number>();
    for (const token of tokens) {
        const posting = index.titlePostings.get(token);
        if (!posting) continue;
        for (const i of posting) {
            if (considered.has(i)) continue;
            considered.add(i);
            if (
                titleJaccard(tokens, index.titleTokenSets[i]) >=
                READ_STORY_TITLE_JACCARD_THRESHOLD
            ) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Read the opened impressions and build the index. ONE query per sync/gate pass;
 * callers hold the result for the whole run rather than rebuilding per chunk.
 *
 * Uses `getAll()` rather than `getOpenedSeenBreakdown()` + `getOpenedTitleNorms()`
 * deliberately: this gate needs the three keys TOGETHER (an id-less title and a
 * title-less id must stay independently matchable), and those two accessors
 * return them pre-split across two separate queries. The opened filter is
 * re-applied in `buildReadStoryIndex`.
 *
 * Fails open to `EMPTY_READ_STORY_INDEX` — a read failure must never start
 * hiding articles, and must never fail the sync.
 */
export async function loadReadStoryIndex(): Promise<ReadStoryIndex> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const impressions = require('@/lib/database/services/story-impression-service') as typeof import('@/lib/database/services/story-impression-service');
        const rows = await impressions.getAll();
        return buildReadStoryIndex(rows as unknown as ReadStoryImpressionRow[]);
    } catch (err) {
        logger.captureException(err, {
            tags: { module: 'read-story-filter', step: 'load-index' },
        });
        return EMPTY_READ_STORY_INDEX;
    }
}

/**
 * Write rows terminal `already_read` in one batch.
 *
 * Shaped exactly like `article-suggestion-service::batchMarkExcluded` (zeroed
 * scores, cleared reason, `scored_at` stamped only when still null, tolerant of a
 * row hard-deleted underneath an in-flight batch) — but a SEPARATE status, so the
 * Observability funnel can tell "you said not interested" apart from "you already
 * read this". It lives here rather than in `article-suggestion-service` only
 * because that file is owned by another change in flight; a
 * `batchMarkStatus(ids, status)` helper there would be the cleaner long-term home
 * and would delete this function.
 */
export async function batchMarkAlreadyRead(
    ids: string[],
    nowMs: number = Date.now(),
): Promise<void> {
    if (ids.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const database = (require('@/lib/database') as typeof import('@/lib/database')).default;
    const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
    const rows = (
        await Promise.all(
            ids.map((id) => articleSuggestionsCol.find(id).catch(() => null)),
        )
    ).filter((r): r is ArticleSuggestionModel => r != null);
    if (rows.length === 0) return;
    await database.write(async () => {
        await database.batch(
            rows.map((row) =>
                row.prepareUpdate((r) => {
                    r.relevance = 0;
                    r.reason = '';
                    r.rawScore = 0;
                    r.computedScore = 0;
                    r.status = ArticleSuggestionStatus.AlreadyRead;
                    if (r.scoredAt == null) r.scoredAt = nowMs;
                }),
            ),
        );
    });
}
