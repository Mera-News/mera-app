// Explore tab — Top Stories blend.
//
// The 'top' scope (see lib/explore/scopes.ts) blends two editions — the
// GLOBAL top-headlines page and the user's home-country top-headlines page
// (both from `ArticleService.getTopHeadlinesForCountry`) — into one ranked
// list. `blendTopStories` is a pure function (no I/O, no RN) so it's cheap to
// unit test exhaustively; `getPersonaStableIds` is the one impure helper here
// (a local WatermelonDB read) supplying the persona-boost signal.

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import type { NewsArticle } from '@/lib/generated/graphql-types';

export type TopStoriesSource = 'global' | 'home';

/** One edition's headline slot, normalized for blending. */
export interface BlendInput {
    readonly article: NewsArticle;
    /** Cross-run stable story id; null for an unclustered singleton. */
    readonly stableClusterId: string | null;
    /** Global cluster size across the clustering window; 0 for a singleton. */
    readonly clusterSize: number;
    /** 0-based position within its edition's own headline ordering (across
     *  all pages fetched so far — page 2 continues the count from page 1). */
    readonly editionRank: number;
    readonly source: TopStoriesSource;
}

export interface BlendedHeadline {
    readonly article: NewsArticle;
    readonly stableClusterId: string | null;
    readonly clusterSize: number;
    readonly source: TopStoriesSource;
    readonly score: number;
}

/** Dedupe key: stable cluster id when known, else the article id (singletons
 *  never collide across editions unless it's literally the same article). */
function dedupeKey(b: Pick<BlendInput, 'stableClusterId' | 'article'>): string {
    return b.stableClusterId ? `cluster:${b.stableClusterId}` : `article:${b.article._id}`;
}

/**
 * Blend the GLOBAL and home-country top-headline editions into one ranked,
 * deduped list.
 *
 * - Dedupe across editions by {@link dedupeKey}; home wins on collision (a
 *   story that's big enough to be a home headline stays attributed to home
 *   even if it also appears in GLOBAL).
 * - Score = 0.6·popNorm + 0.4·rankPrior + (0.35 when the story matches a
 *   local persona signal), where:
 *     popNorm   = log(1+clusterSize) / log(1+maxClusterSize), 0 when max=0
 *     rankPrior = 1 / (1 + 0.05·editionRank)
 * - Sorted score-desc, then passed through an interleave guard that swaps a
 *   4th consecutive same-source item ahead with the next different-source
 *   item so no more than 3 in a row share a source.
 */
export function blendTopStories(
    global: readonly BlendInput[],
    home: readonly BlendInput[],
    personaStableIds: ReadonlySet<string>,
): BlendedHeadline[] {
    const byKey = new Map<string, BlendInput>();

    // Home first so home wins when a GLOBAL entry collides with it.
    for (const b of home) {
        byKey.set(dedupeKey(b), b);
    }
    for (const b of global) {
        const key = dedupeKey(b);
        if (!byKey.has(key)) byKey.set(key, b);
    }

    const merged = Array.from(byKey.values());
    const maxClusterSize = merged.reduce((max, b) => Math.max(max, b.clusterSize), 0);

    const scored: BlendedHeadline[] = merged.map((b) => {
        const popNorm = maxClusterSize > 0 ? Math.log(1 + b.clusterSize) / Math.log(1 + maxClusterSize) : 0;
        const rankPrior = 1 / (1 + 0.05 * b.editionRank);
        const personaBoost = b.stableClusterId && personaStableIds.has(b.stableClusterId) ? 0.35 : 0;
        return {
            article: b.article,
            stableClusterId: b.stableClusterId,
            clusterSize: b.clusterSize,
            source: b.source,
            score: 0.6 * popNorm + 0.4 * rankPrior + personaBoost,
        };
    });

    scored.sort((a, b) => b.score - a.score);

    return applyInterleaveGuard(scored);
}

/**
 * Greedy single pass: whenever three consecutive items share a source, swap
 * the third one ahead with the nearest later item from a different source
 * (if any exists). Keeps the score-desc ordering as close to intact as
 * possible while breaking up long same-source runs.
 */
function applyInterleaveGuard(sorted: BlendedHeadline[]): BlendedHeadline[] {
    const result = [...sorted];
    for (let i = 2; i < result.length; i++) {
        const source = result[i].source;
        if (result[i - 1].source !== source || result[i - 2].source !== source) continue;
        let swapIdx = -1;
        for (let j = i + 1; j < result.length; j++) {
            if (result[j].source !== source) {
                swapIdx = j;
                break;
            }
        }
        if (swapIdx !== -1) {
            [result[i], result[swapIdx]] = [result[swapIdx], result[i]];
        }
    }
    return result;
}

const articleSuggestionsCol = () => database.get<ArticleSuggestionModel>('article_suggestions');

/**
 * Distinct non-null `stable_cluster_id` values across local `article_suggestions`
 * — the on-device persona signal used to boost stories the user's feed has
 * already surfaced. Never sent to the server; read-only local aggregation.
 */
export async function getPersonaStableIds(): Promise<Set<string>> {
    const rows = await articleSuggestionsCol()
        .query(Q.where('stable_cluster_id', Q.notEq(null)))
        .fetch();
    const ids = new Set<string>();
    for (const row of rows) {
        if (row.stableClusterId) ids.add(row.stableClusterId);
    }
    return ids;
}
