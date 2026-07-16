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
 * therefore group by the UNION of weak signals:
 *   1. Same clusterId at high membership confidence (catches paraphrases that
 *      share little title text — 205/273 same-cluster pairs had title Jaccard
 *      < 0.35, e.g. the ASML earnings pairs at 0.12–0.18).
 *   2. Title-token Jaccard over the same clustering-agnostic key (bridges
 *      articles stranded in different clustering generations — 34/73 title
 *      groups in the dump spanned multiple clusterIds).
 *   3. (DISPLAY-only, opt-in) an IDF-weighted title edge gated on a rare-token
 *      anchor, which recovers same-story paraphrases that share distinctive rare
 *      tokens but too little raw title text to clear signal (2) — see
 *      `WEIGHTED_JACCARD_*`. Absent from score-propagation, which keeps signals
 *      (1)+(2) only.
 * Union-find over signals (1)+(2) collapsed the dump into 163 multi-article
 * groups → 256 fewer cards (18.2%); adding (3) at the display layer collapses a
 * further 13 same-story pairs the raw title bar missed.
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
    /**
     * Optional IDF-weighted title-Jaccard bar for an additional DISPLAY edge.
     * When absent/undefined the weighted edge is DISABLED — existing callers and
     * score-propagation keep their exact prior behavior (raw Jaccard + cluster
     * edges only). When set, a candidate pair also merges if its IDF-weighted
     * title Jaccard clears this bar AND the pair shares a rare-token anchor (see
     * `WEIGHTED_JACCARD_*` constants). See `weightedTitleJaccard` for the metric.
     */
    weightedJaccardThreshold?: number;
}

/**
 * Minimum HDBSCAN membership confidence for a cluster edge to count. Calibrated
 * 2026-07 against the 1410-suggestion feed dump. Originally 0.5; lowered to 0.3
 * after an offline precision sweep over the dump showed ≥ 0.3 newly and safely
 * merges genuine same-story sets whose top member confidence sits in the
 * 0.35–0.49 band — the 6-article Amsterdam Red-Light-District trafficking set
 * (a 0.485 member), the Poland/Italy-ETS pair (~0.35), the EU-emission-leak pair
 * (~0.40) — with ZERO false merges observed at 0.3. Dropping to 0.15 introduces a
 * false merge (an Indonesia-tax pair), so 0.3 is the floor. Near-zero
 * confidences (1e-38 etc.) are HDBSCAN noise artifacts, correctly excluded.
 *
 * This constant is SHARED with score-propagation. The pairs newly bridged at 0.3
 * are same-story, so copying a donor's relevance/reason across them is
 * acceptable (not just cosmetic) — the propagation stays correct.
 */
export const CLUSTER_CORE_CONFIDENCE_THRESHOLD = 0.3;

/**
 * IDF-weighted title-Jaccard bar for the optional weighted DISPLAY edge.
 * Calibrated 2026-07 against the 1410-suggestion dump (747 visible items).
 *
 * The raw-Jaccard edge stays at 0.4 (lowering it to 0.3 was REJECTED — ~20%
 * precision; it merged generic AI-opinion pieces sharing only high-frequency
 * topic tokens). The weighted edge instead scores a candidate pair by IDF-
 * weighted Jaccard — rare shared tokens ("kidnapping", "bih", "emergent")
 * dominate; ubiquitous ones ("artificial", "intelligence", "report") barely
 * count — but gates the merge on the rare-token ANCHOR below, which turned out
 * to be the real discriminator (over a 747-doc corpus the log-IDF range is only
 * ~3.0–6.9, so the weighted ratio alone barely separates true pairs at
 * ~0.29–0.41 from coincidences). At ≥ 0.28 weighted Jaccard PLUS the anchor
 * rule, the offline sweep produced 13 weighted edges, 12 genuinely same-story:
 * both Amsterdam-kidnapping pairs, Russian-embassy/TASS, BiH social-security,
 * EU↔X transparency (3 edges incl. the accepts/platform target pair), the
 * Australia-AI-regulation pair, Emergent-unicorn, TCS-NVIDIA, a markets-wrap
 * pair, and the Shusha-forum pair. Every MUST-NOT-MERGE AI-opinion negative
 * stayed separate. Two false edges that the anchor cap alone could not exclude
 * were pushed below the bar by this 0.28 floor: the "AI cognitive decline"
 * bridge ("Does AI weaken thinking ability?" ↔ "…weaken memory and critical
 * thinking", weighted 0.269) and a Russian-ambassador cross-story pair
 * (sanctions vs. cyber-attack summons, weighted 0.261). The floor sits in the
 * empty band (0.269, 0.291] — below both of those and below the kidnapping
 * targets' 0.291 — so it is not a knife-edge. The ONE residual imperfect edge
 * is an "India–New Zealand" trade item pulled into the "EU–India" trade group
 * via the generic bigram "strategic partnership" (weighted 0.321): it sits
 * ABOVE the kidnapping/BiH targets (~0.29–0.30), so no wFloor can drop it
 * without also dropping primary targets — accepted as a cosmetic display-only
 * over-merge. DISPLAY-only — deliberately NOT wired into score-propagation,
 * which keeps the stricter raw-Jaccard-only signal.
 */
export const WEIGHTED_JACCARD_DISPLAY_THRESHOLD = 0.28;

/**
 * Rare-token anchor for the weighted edge: a pair merges via the weighted edge
 * only if it shares at least `WEIGHTED_JACCARD_MIN_ANCHORS` tokens whose document
 * frequency is ≤ `WEIGHTED_JACCARD_ANCHOR_DF_MAX` over the grouping input. This
 * is what actually separates same-story paraphrases from topical coincidences:
 * ≥ 2 genuinely-rare shared tokens, so a high weighted score can't ride on a
 * single distinctive token or on shared common words. Calibrated 2026-07 against
 * the dump: the df cap is 8 — high enough to admit the story-specific anchors of
 * every primary target, notably the EU↔X "platform" (df 8) and "kidnapping"
 * (df 7) tokens, while the ambiguous pairs that also reach into the df-8 band
 * (the "AI cognitive decline" bridge on "thinking" df 8, the Russian-ambassador
 * pair) are instead separated by the weighted-Jaccard floor above rather than by
 * the cap. Two anchors is the floor because the kidnapping targets legitimately
 * match on exactly two ("possible"+"kidnapping"); requiring three would lose
 * them.
 */
export const WEIGHTED_JACCARD_ANCHOR_DF_MAX = 8;
export const WEIGHTED_JACCARD_MIN_ANCHORS = 2;

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

/**
 * Inverse document frequency of a token over a corpus: log((N+1)/(df+1)) + 1.
 * Smoothed (the +1s) so df=0 and df=N are both finite; the trailing +1 keeps
 * every weight strictly positive (a token present everywhere still counts a
 * little). Higher = rarer = more discriminating.
 */
function idf(df: number, n: number): number {
    return Math.log((n + 1) / (df + 1)) + 1;
}

/**
 * IDF-weighted Jaccard between two token sets: (sum of idf-weights of shared
 * tokens) / (sum of idf-weights of the union). Weighting rare tokens up and
 * ubiquitous tokens down is what lets a distinctive same-story pair clear the
 * bar while two pieces sharing only high-frequency topic words ("artificial",
 * "intelligence") stay well below it. `dfByToken`/`n` describe the corpus the
 * grouping input itself forms. Two empty sets → 0 (no evidence).
 */
export function weightedTitleJaccard(
    a: Set<string>,
    b: Set<string>,
    dfByToken: Map<string, number>,
    n: number,
): number {
    if (a.size === 0 && b.size === 0) {
        return 0;
    }
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let sharedWeight = 0;
    let unionWeight = 0;
    // Union weight = all of `large` + the non-shared tokens of `small`.
    for (const token of large) {
        unionWeight += idf(dfByToken.get(token) ?? 0, n);
    }
    for (const token of small) {
        const w = idf(dfByToken.get(token) ?? 0, n);
        if (large.has(token)) {
            sharedWeight += w;
        } else {
            unionWeight += w;
        }
    }
    return unionWeight === 0 ? 0 : sharedWeight / unionWeight;
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
 * Group items into stories via union-find over up to three edge types:
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
 *   3. Weighted title edges (OPTIONAL — only when `opts.weightedJaccardThreshold`
 *      is set) — over the SAME candidate pairs as (2), a pair that failed the raw
 *      Jaccard bar still merges if its IDF-weighted title Jaccard is
 *      ≥ `opts.weightedJaccardThreshold` AND it shares ≥ 2 rare tokens
 *      (df ≤ `WEIGHTED_JACCARD_ANCHOR_DF_MAX`). Rare shared tokens dominate the
 *      score, so distinctive same-story paraphrases merge while pieces sharing
 *      only high-frequency topic words do not. Absent → behavior identical to the
 *      two-edge version.
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

    // Build token → posting list (indices, ascending by construction). The
    // posting-list length IS the document frequency of the token over this
    // input, so it doubles as the corpus statistic for the weighted edge.
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

    // Weighted-edge corpus stats (only when the weighted edge is enabled).
    const weightedEnabled = opts.weightedJaccardThreshold !== undefined;
    const dfByToken = new Map<string, number>();
    if (weightedEnabled) {
        for (const [token, list] of postings) {
            dfByToken.set(token, list.length);
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
            const setJ = tokenSets[j];
            if (titleJaccard(setI, setJ) >= opts.titleJaccardThreshold) {
                union(parent, i, j);
                continue;
            }
            // Optional IDF-weighted edge: merge when the rare shared tokens carry
            // enough weight AND the pair clears the rare-token anchor (≥ 2 shared
            // tokens with df ≤ cap). The anchor stops a high weighted score from
            // riding on a single distinctive token.
            if (weightedEnabled) {
                let rareAnchors = 0;
                for (const token of setI) {
                    if (
                        setJ.has(token) &&
                        (dfByToken.get(token) ?? 0) <= WEIGHTED_JACCARD_ANCHOR_DF_MAX
                    ) {
                        rareAnchors += 1;
                    }
                }
                if (
                    rareAnchors >= WEIGHTED_JACCARD_MIN_ANCHORS &&
                    weightedTitleJaccard(setI, setJ, dfByToken, n) >=
                        (opts.weightedJaccardThreshold as number)
                ) {
                    union(parent, i, j);
                }
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
