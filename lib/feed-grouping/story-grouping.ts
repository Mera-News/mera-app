/**
 * Shared story-grouping utility for the For-You feed.
 *
 * Pure functions only — NO imports from React Native, WatermelonDB, Zustand
 * stores, or the logger. This module is unit-tested in isolation and is safe to
 * import from any layer (feed sync, scoring pipeline, screen memos).
 *
 * The problem it solves: the server's HDBSCAN clustering job wipes and
 * re-inserts `news-cluster`/`cluster-article-link` with fresh `_id`s every run,
 * so there is no stable story key. Already-synced app rows freeze at whichever
 * clustering generation was live when their article id was last fetched — a real
 * 1410-suggestion dump (2026-07) had 6 generations coexisting, and the same
 * OpenAI-speaker story appeared as 8 articles in 8 different clusterIds. We
 * therefore group by the UNION of two weak signals:
 *   1. Same clusterId at high membership confidence (catches paraphrases that
 *      share little title text — 205/273 same-cluster pairs had title Jaccard
 *      < 0.35, e.g. the ASML earnings pairs at 0.12–0.18).
 *   2. Title-token Jaccard over the same clustering-agnostic key (bridges
 *      articles stranded in different clustering generations — 34/73 title
 *      groups in the dump spanned multiple clusterIds).
 * Combined union-find over both edge types collapsed the dump into 163
 * multi-article groups → 256 fewer cards (18.2%).
 */

import type { ClusterMembership } from '@/lib/stores/for-you-store';

export interface GroupableItem {
    id: string;
    title: string | null;
    clusters: ClusterMembership[];
}

export interface StoryGroupingOptions {
    titleJaccardThreshold: number;
    clusterConfidenceThreshold: number;
}

/**
 * Minimum HDBSCAN membership confidence for a cluster edge to count. Calibrated
 * 2026-07 against the 1410-suggestion feed dump: at ≥ 0.5, shared-cluster edges
 * caught paraphrase pairs that title text alone missed (205/273 same-cluster
 * pairs had title Jaccard < 0.35). Below this bar, low-confidence HDBSCAN
 * fringe memberships start merging unrelated stories.
 */
export const CLUSTER_CORE_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Title-token Jaccard bar for a DISPLAY merge (collapsing cards in the feed).
 * Calibrated 2026-07 against the dump: at ≥ 0.4, title edges bridged the server's
 * per-run clustering generations (wipe-and-insert per run, 6 generations
 * coexisted; 34/73 title-groups spanned multiple clusterIds). A wrong display
 * merge is only cosmetic, so this bar is deliberately looser than the
 * propagation bar below.
 */
export const TITLE_JACCARD_DISPLAY_THRESHOLD = 0.4;

/**
 * Title-token Jaccard bar for SCORE PROPAGATION (copying a scored donor's
 * relevance/reason onto an unscored sibling). Stricter than the display bar:
 * a wrong display merge is cosmetic, but a wrong score copy mis-ranks or hides
 * an article. Calibrated 2026-07: within-group relevance agreed within 0.2 in
 * 80/92 groups, so the extra precision at 0.55 protects ranking without losing
 * the real merges. Cluster edges stay at 0.5 for both display and propagation.
 */
export const TITLE_JACCARD_PROPAGATION_THRESHOLD = 0.55;

/**
 * How far back to look for scored "donor" rows when propagating scores onto
 * unscored siblings. Matches the `article_suggestions` 48h TTL prune, so a donor
 * that could still be in the local DB is always eligible.
 */
export const SCORE_PROPAGATION_LOOKBACK_MS = 48 * 3600_000;

/**
 * ~60 English stopwords stripped before title tokenization. These are the
 * high-frequency function words and news-headline filler ("says", "new",
 * "report") that would otherwise inflate Jaccard between unrelated headlines.
 */
const TITLE_STOPWORDS = new Set<string>([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'our', 'out',
    'into', 'about', 'more', 'most', 'all', 'can', 'could', 'would', 'should',
    'than', 'then', 'when', 'what', 'who', 'how', 'why', 'where', 'while',
    'during', 'against', 'between', 'before', 'under', 'per', 'via', 'off',
    'from', 'after', 'amid', 'over', 'its', 'his', 'her', 'their', 'this',
    'that', 'has', 'have', 'new', 'says', 'said', 'was', 'were', 'been', 'they',
    'them', 'will', 'down', 'with',
]);

// Tokens whose posting list is longer than this are skipped for candidate-pair
// BLOCKING only (they are too common to narrow the search). They still count
// toward the Jaccard numerator/denominator once a pair is otherwise a candidate.
const HOT_TOKEN_POSTING_LIMIT = 50;

/**
 * Tokenize a title into a deduplicated set of comparable tokens:
 * lowercase → non-alphanumerics to spaces → split on whitespace → keep tokens
 * with length > 2 → drop stopwords. Null/empty/whitespace titles yield an empty
 * set. Never throws.
 */
export function normalizeTitleTokens(title: string | null | undefined): Set<string> {
    const tokens = new Set<string>();
    if (!title) {
        return tokens;
    }
    const cleaned = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    for (const token of cleaned.split(/\s+/)) {
        if (token.length > 2 && !TITLE_STOPWORDS.has(token)) {
            tokens.add(token);
        }
    }
    return tokens;
}

/**
 * Jaccard similarity between two token sets: |intersection| / |union|.
 * Two empty sets → 0 (no evidence, not a perfect match).
 */
export function titleJaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) {
        return 0;
    }
    // Iterate the smaller set for the intersection count.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const token of small) {
        if (large.has(token)) {
            intersection += 1;
        }
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// --- Union-find (array parent + path compression) -------------------------

function find(parent: number[], i: number): number {
    let root = i;
    while (parent[root] !== root) {
        root = parent[root];
    }
    // Path compression: point every node on the walk directly at the root.
    let node = i;
    while (parent[node] !== root) {
        const next = parent[node];
        parent[node] = root;
        node = next;
    }
    return root;
}

function union(parent: number[], a: number, b: number): void {
    const ra = find(parent, a);
    const rb = find(parent, b);
    if (ra !== rb) {
        // Attach the larger-indexed root under the smaller — keeps roots biased
        // toward earlier input items, which aids determinism of group ordering.
        if (ra < rb) {
            parent[rb] = ra;
        } else {
            parent[ra] = rb;
        }
    }
}

/**
 * Group items into stories via union-find over two edge types:
 *
 *   1. Cluster edges — items sharing a clusterId whose membership confidence is
 *      ≥ `opts.clusterConfidenceThreshold` are unioned. Built from a
 *      clusterId → indices map in O(total memberships).
 *   2. Title edges — items whose normalized-title Jaccard is
 *      ≥ `opts.titleJaccardThreshold` are unioned. Candidate pairs are found via
 *      an inverted token index (NOT naive O(n²)): each item is compared only to
 *      LATER-indexed items that share enough tokens. Hot tokens (posting list
 *      > 50) are skipped for blocking but still count inside the Jaccard.
 *      A pair is a candidate when it shares ≥ 2 tokens, relaxed to ≥ 1 when
 *      either title has ≤ 3 tokens.
 *
 * Returns groups (singletons included), preserving input order both across
 * groups (by each group's earliest member index) and within each group.
 * Deterministic for a given input order. Never throws. Edge cases: null/empty
 * titles contribute no title edges (cluster edges still apply); items with no
 * clusters contribute no cluster edges; an item with neither is a singleton.
 */
export function buildStoryGroups<T extends GroupableItem>(
    items: T[],
    opts: StoryGroupingOptions,
): T[][] {
    const n = items.length;
    if (n === 0) {
        return [];
    }

    const parent: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
        parent[i] = i;
    }

    // --- 1. Cluster edges ---------------------------------------------------
    const clusterToIndices = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
        const clusters = items[i].clusters;
        if (!clusters) {
            continue;
        }
        for (const membership of clusters) {
            if (
                membership &&
                membership.confidence >= opts.clusterConfidenceThreshold &&
                membership.clusterId
            ) {
                let bucket = clusterToIndices.get(membership.clusterId);
                if (!bucket) {
                    bucket = [];
                    clusterToIndices.set(membership.clusterId, bucket);
                }
                bucket.push(i);
            }
        }
    }
    for (const indices of clusterToIndices.values()) {
        for (let k = 1; k < indices.length; k += 1) {
            union(parent, indices[0], indices[k]);
        }
    }

    // --- 2. Title edges (inverted-index blocking) ---------------------------
    // Tokenize every title once.
    const tokenSets: Set<string>[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
        tokenSets[i] = normalizeTitleTokens(items[i].title);
    }

    // Build token → posting list (indices, ascending by construction).
    const postings = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
        for (const token of tokenSets[i]) {
            let list = postings.get(token);
            if (!list) {
                list = [];
                postings.set(token, list);
            }
            list.push(i);
        }
    }

    // For each item, tally shared-token counts against LATER-indexed items
    // using the (non-hot) posting lists, then compute the full Jaccard only for
    // candidate pairs.
    const sharedCounts = new Map<number, number>();
    for (let i = 0; i < n; i += 1) {
        const setI = tokenSets[i];
        if (setI.size === 0) {
            continue;
        }
        sharedCounts.clear();
        for (const token of setI) {
            const list = postings.get(token);
            if (!list || list.length > HOT_TOKEN_POSTING_LIMIT) {
                continue; // Hot tokens are skipped for BLOCKING only.
            }
            for (const j of list) {
                if (j > i) {
                    sharedCounts.set(j, (sharedCounts.get(j) ?? 0) + 1);
                }
            }
        }
        for (const [j, shared] of sharedCounts) {
            // Candidate threshold: ≥ 2 shared tokens, relaxed to ≥ 1 when either
            // title is very short (≤ 3 tokens) — short headlines can't reach 2
            // shared tokens yet still legitimately match.
            const shortTitle = setI.size <= 3 || tokenSets[j].size <= 3;
            const minShared = shortTitle ? 1 : 2;
            if (shared < minShared) {
                continue;
            }
            if (find(parent, i) === find(parent, j)) {
                continue; // Already merged (e.g. via a cluster edge).
            }
            if (titleJaccard(setI, tokenSets[j]) >= opts.titleJaccardThreshold) {
                union(parent, i, j);
            }
        }
    }

    // --- Materialize groups in input order ---------------------------------
    // Root's first-seen index defines group ordering; members stay in input
    // order because we iterate i ascending.
    const groupsByRoot = new Map<number, T[]>();
    for (let i = 0; i < n; i += 1) {
        const root = find(parent, i);
        let group = groupsByRoot.get(root);
        if (!group) {
            group = [];
            groupsByRoot.set(root, group);
        }
        group.push(items[i]);
    }
    return Array.from(groupsByRoot.values());
}

/**
 * Pick the single representative of a group using `compare` (a comparator in
 * standard sort order — negative means `a` sorts before `b`). Single pass, no
 * sort. When `compare` returns 0, the lexicographically smaller `id` wins, so
 * the result is fully deterministic.
 *
 * The group MUST be non-empty (guaranteed by `buildStoryGroups`, which never
 * emits an empty group). Throws on an empty array.
 */
export function pickRepresentative<T extends GroupableItem>(
    group: T[],
    compare: (a: T, b: T) => number,
): T {
    if (group.length === 0) {
        throw new Error('pickRepresentative: group must be non-empty');
    }
    let best = group[0];
    for (let i = 1; i < group.length; i += 1) {
        const candidate = group[i];
        const cmp = compare(candidate, best);
        if (cmp < 0 || (cmp === 0 && candidate.id < best.id)) {
            best = candidate;
        }
    }
    return best;
}
