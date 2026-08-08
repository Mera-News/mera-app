/**
 * Gray-band duplicate-candidate enumerator — MEASUREMENT / DIAGNOSTICS ONLY.
 *
 * WHAT PROBLEM THIS DOES *NOT* SOLVE. "Filter duplicates before relevance
 * scoring to save LLM spend" is already shipped, lexically, for free:
 *   - `read-story-filter.ts` is a PRE-SCORING gate on
 *     `article_id` ∪ `stable_cluster_id` ∪ normalized-title Jaccard ≥ 0.55.
 *   - `score-propagation.ts` copies a scored donor's relevance/reason onto
 *     same-story siblings and elects one representative per duplicate group.
 * The residual those two miss is the GRAY BAND: pairs that are plainly the same
 * story but sit below the 0.55 propagation bar — overwhelmingly cross-language
 * or independently-rewritten coverage whose titles share almost no tokens. This
 * module enumerates exactly that residual so it can be COUNTED. It sends
 * nothing anywhere, calls no model, and changes no user-visible behaviour.
 *
 * WHY THE AXIS CHANGED, AND WHY THE OLD NUMBER DOES NOT TRANSFER. The band was
 * originally specified as title Jaccard ∈ [0.30, 0.55). Those are JACCARD
 * numbers; applied to a Hamming or cosine distance they are meaningless. The
 * bar below was re-derived from scratch against real prod vectors — see
 * `GRAY_BAND_MAX_HAMMING`.
 *
 * THE CANDIDATE GENERATOR IS THE SERVER'S SIGN-BIT SIDECAR.
 * `ArticleWithClusters.vector_sidecar_packed` is the 768-dim retrieval
 * embedding packed to one sign bit per dimension — 96 bytes/article, ~38 KB per
 * 400-article sync, against 1.2 MB for float32. Distance is an integer popcount
 * over 96 bytes; over the ~10²–10³ articles a device holds in the 48h window a
 * brute-force all-pairs sweep is microseconds of plain JS. (An ANN index was
 * considered and rejected: ANN earns its keep at 10⁵–10⁶ vectors, and every
 * available implementation would require a React Native native module.)
 *
 * The lexical signals stay as a FALLBACK for articles whose sidecar has not
 * arrived — which today is *every* article, because the server writes the
 * column but no prod article carries one yet.
 *
 * PURE + RN-FREE, like the rest of `lib/feed-grouping`: no React Native,
 * WatermelonDB, Zustand or logger imports, so it is safe to call from the
 * diagnostics report, a test, or an offline script.
 */

import {
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    TITLE_JACCARD_PROPAGATION_THRESHOLD,
    buildStoryGroups,
    normalizeTitleTokens,
    titleJaccard,
    type GroupableItem,
} from './story-grouping';

/**
 * Maximum Hamming distance (over 768 sign bits) at which two articles are
 * enumerated as a same-story candidate. ≈ cosine 0.855, since
 * `cos ≈ cos(π·d/768)` for sign-bit vectors.
 *
 * DERIVED, NOT GUESSED — 2026-08-08, four ~300-article corpora rebuilt from the
 * live prod serve path (`topic-article-link` unions, i.e. the exact shape of a
 * persona's scoring batch), with real `embedding_article_data_retrieval`
 * vectors and real `cluster-article-link` memberships:
 *
 *  1. ANCHOR. The honest translation of "the bar at which propagation already
 *     merges" onto the new axis is the Hamming distance that captures the pairs
 *     the 0.55-Jaccard propagation bar merges. Measured over 140 such pairs:
 *     d ≤ 120 captures 80.7%, d ≤ 140 captures 92.1%, d ≤ 160 captures 97.9%.
 *     So the same semantic bar lands at d ≈ 130–140, NOT at any number
 *     resembling 0.30.
 *  2. PRECISION. All 164 pairs enumerated at d ≤ 140 (component filter applied)
 *     were read by hand. Below d = 130 essentially every pair is genuinely the
 *     same story; the 131–140 slice is where the false pairs concentrate
 *     ("OpenAI asks judge to dismiss Apple's suit" ↔ "As Apple Kicks the AI Can
 *     Down the Road"; two unrelated Japanese tender notices matching on
 *     boilerplate). 130 sits just under that degradation.
 *
 * Loosening this past ~140 buys recall the propagation bar never had, at a
 * precision the project's standing favour-splitting rule does not accept.
 *
 * ABSOLUTE, NOT POOL-RELATIVE — deliberately unlike `entityAnchorDfMax`, whose
 * cap scales with the grouping pool. That one had to: a DOCUMENT FREQUENCY is a
 * property of the corpus, so "rare" means something different in a 10² feed
 * window than in a 10³ article-detail pool. A Hamming distance is a property of
 * the two vectors alone and does not move when the pool around them grows, so
 * the same two articles must merge identically on every call site. Do not
 * "fix" this into a ratio.
 */
export const GRAY_BAND_MAX_HAMMING = 130;

/** Bits in the sidecar the constant above was calibrated against (Jina
 *  `jina-embeddings-v5-text-nano` is 768-dim → 96 bytes). A sidecar of any
 *  other length is rejected rather than silently rescaled: a wrong-length
 *  vector produces a plausible-looking but meaningless distance. */
export const SIDECAR_BITS = 768;
const SIDECAR_BYTES = SIDECAR_BITS / 8;

/**
 * Lower bar for the LEXICAL fallback, used only for pairs where at least one
 * side has no sidecar. Unchanged from the original lexical specification: the
 * band is title Jaccard ∈ [0.30, 0.55), the upper edge being the propagation
 * bar itself (anything at or above it is already merged, so it can never be
 * enumerated here anyway).
 */
export const GRAY_BAND_LEXICAL_LOWER = 0.3;

/**
 * Hard cap on pairs returned per sweep. Bounds the cost of anything a caller
 * might later do per pair, and bounds the diagnostics payload. Pairs are
 * returned closest-first, so the cap drops the weakest candidates.
 */
export const MAX_GRAY_BAND_PAIRS = 60;

/** Item shape the enumerator consumes: a `GroupableItem` (so the existing
 *  grouping options, tokenizer and union-find apply unchanged) plus the
 *  base64 sidecar the server puts on the wire. */
export interface DedupCandidate extends GroupableItem {
    /** Base64 of the 96-byte packed sign-bit sidecar, exactly as
     *  `ArticleWithClusters.vector_sidecar_packed` delivers it. Null/absent ⇒
     *  this article falls back to the lexical signals. */
    vectorSidecarPacked?: string | null;
}

export interface GrayBandPair {
    /** Ids in ascending order, so a pair has one canonical form. */
    aId: string;
    bId: string;
    /** Which signal produced the pair. */
    axis: 'vector' | 'lexical';
    /** Hamming distance over the 768 sign bits — `vector` axis only. */
    hamming: number | null;
    /** Estimated cosine (`vector`) or title Jaccard (`lexical`). Comparable
     *  within an axis only; the two are different quantities. */
    similarity: number;
}

export interface GrayBandOptions {
    /** Defaults to {@link GRAY_BAND_MAX_HAMMING}. */
    maxHamming?: number;
    /** Defaults to {@link GRAY_BAND_LEXICAL_LOWER}. */
    lexicalLowerBound?: number;
    /** Defaults to {@link MAX_GRAY_BAND_PAIRS}. */
    maxPairs?: number;
}

// --- base64 → bytes -------------------------------------------------------
// Hand-rolled rather than `atob`/`Buffer`: this module is imported by pure
// units that run under Node (jest, harness-local) and under Hermes, and the
// two disagree about which of those globals exist.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64_ALPHABET.length; i += 1) t[B64_ALPHABET.charCodeAt(i)] = i;
    return t;
})();

/**
 * Decode a base64 sidecar to bytes. Returns null for anything that is not a
 * clean {@link SIDECAR_BYTES}-byte payload — absent, empty, malformed, or the
 * wrong length. Never throws: a bad sidecar must degrade to the lexical
 * fallback, never break a sweep.
 */
export function decodeSidecar(b64: string | null | undefined): Uint8Array | null {
    if (typeof b64 !== 'string' || b64.length === 0) return null;
    let end = b64.length;
    while (end > 0 && b64.charCodeAt(end - 1) === 61 /* '=' */) end -= 1;
    // Every 4 base64 chars carry 3 bytes; a 96-byte payload is exactly 128 chars.
    const byteLength = (end * 3) >> 2;
    if (byteLength !== SIDECAR_BYTES) return null;

    const out = new Uint8Array(byteLength);
    let acc = 0;
    let bits = 0;
    let o = 0;
    for (let i = 0; i < end; i += 1) {
        const code = b64.charCodeAt(i);
        const v = code < 128 ? B64_LOOKUP[code] : -1;
        if (v < 0) return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o] = (acc >> bits) & 0xff;
            o += 1;
        }
    }
    return o === byteLength ? out : null;
}

const POPCOUNT = (() => {
    const t = new Uint8Array(256);
    for (let i = 1; i < 256; i += 1) t[i] = (i & 1) + t[i >> 1];
    return t;
})();

/** Hamming distance between two equal-length byte arrays (integer popcount —
 *  no floats anywhere on this path). Returns -1 on a length mismatch. */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
    if (a.length !== b.length) return -1;
    let d = 0;
    for (let i = 0; i < a.length; i += 1) d += POPCOUNT[a[i] ^ b[i]];
    return d;
}

/**
 * Cosine implied by a sign-bit Hamming distance: two random unit vectors agree
 * on a sign bit with probability `1 − θ/π`, so `θ ≈ π·d/bits` and
 * `cos ≈ cos(π·d/bits)`. An ESTIMATE — measured against the float vectors of
 * ~200k prod pairs it carries a mean absolute error of ~0.05 (max ~0.23), which
 * is fine for ranking candidates and NOT fine as a reported similarity.
 */
export function cosineFromHamming(d: number, bits: number = SIDECAR_BITS): number {
    return Math.cos((Math.PI * d) / bits);
}

// --- lexical blocking -----------------------------------------------------
// Mirrors `buildStoryGroups`'s inverted-index blocking (hot-token skip,
// ≥2 shared tokens relaxed to ≥1 for short titles). Kept here rather than
// exported out of story-grouping.ts so that shared, heavily-commented file is
// not perturbed; the two must stay in step, hence this note on both sides of
// the pairing.
const HOT_TOKEN_POSTING_LIMIT = 50;

function lexicalCandidatePairs(tokenSets: Set<string>[]): [number, number][] {
    const n = tokenSets.length;
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
    const out: [number, number][] = [];
    const shared = new Map<number, number>();
    for (let i = 0; i < n; i += 1) {
        if (tokenSets[i].size === 0) continue;
        shared.clear();
        for (const token of tokenSets[i]) {
            const list = postings.get(token);
            if (!list || list.length > HOT_TOKEN_POSTING_LIMIT) continue;
            for (const j of list) {
                if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
            }
        }
        for (const [j, count] of shared) {
            const shortTitle = tokenSets[i].size <= 3 || tokenSets[j].size <= 3;
            if (count < (shortTitle ? 1 : 2)) continue;
            out.push([i, j]);
        }
    }
    return out;
}

/**
 * Enumerate same-story CANDIDATE pairs that the shipped propagation grouping
 * does not already handle.
 *
 * A pair is emitted only when the two items land in DIFFERENT propagation
 * components. Components come from `buildStoryGroups` run with the propagation
 * options (stable-cluster + clusterId + 0.55 title Jaccard, no weighted/entity
 * display edges), so anything read-story filtering or score propagation already
 * collapses is excluded by construction — the output is the residual and
 * nothing else.
 *
 * Vector axis: brute-force over every pair whose two sidecars decoded, kept
 * when `hamming ≤ maxHamming`. Lexical axis: only for pairs where at least one
 * sidecar is missing, using the existing blocking + `titleJaccard` band
 * `[lexicalLowerBound, TITLE_JACCARD_PROPAGATION_THRESHOLD)`.
 *
 * Deterministic for a given input order. Never throws. Returns at most
 * `maxPairs` pairs, strongest first (vector pairs ranked by ascending Hamming,
 * then lexical pairs by descending Jaccard — the vector axis is the calibrated
 * one, so it is never displaced by a lexical fallback).
 */
export function enumerateGrayBandPairs(
    items: DedupCandidate[],
    opts: GrayBandOptions = {},
): GrayBandPair[] {
    return sweepGrayBand(items, opts).pairs;
}

/** Uncapped sweep + the coverage facts the counters need. Exists so
 *  {@link grayBandSweep} can report "found 84, sent 60" — a saturated sweep and
 *  a quiet one are different measurements and must not look identical. */
function sweepGrayBand(
    items: DedupCandidate[],
    opts: GrayBandOptions,
): { pairs: GrayBandPair[]; foundCount: number; withSidecar: number } {
    const n = items.length;
    if (n < 2) return { pairs: [], foundCount: 0, withSidecar: 0 };

    const maxHamming = opts.maxHamming ?? GRAY_BAND_MAX_HAMMING;
    const lexicalLowerBound = opts.lexicalLowerBound ?? GRAY_BAND_LEXICAL_LOWER;
    const maxPairs = opts.maxPairs ?? MAX_GRAY_BAND_PAIRS;

    // Propagation components — the "already handled" set.
    const componentOf = new Map<string, number>();
    const groups = buildStoryGroups(items, {
        titleJaccardThreshold: TITLE_JACCARD_PROPAGATION_THRESHOLD,
        clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    });
    groups.forEach((group, index) => {
        for (const item of group) componentOf.set(item.id, index);
    });

    const sidecars: (Uint8Array | null)[] = new Array(n);
    let withSidecar = 0;
    for (let i = 0; i < n; i += 1) {
        sidecars[i] = decodeSidecar(items[i].vectorSidecarPacked);
        if (sidecars[i]) withSidecar += 1;
    }

    const sameComponent = (i: number, j: number): boolean => {
        const a = componentOf.get(items[i].id);
        const b = componentOf.get(items[j].id);
        return a !== undefined && a === b;
    };
    const pairOf = (i: number, j: number): [string, string] => {
        const a = items[i].id;
        const b = items[j].id;
        return a <= b ? [a, b] : [b, a];
    };

    const vectorPairs: GrayBandPair[] = [];
    const lexicalPairs: GrayBandPair[] = [];
    // Pairs decided on the vector axis are never re-offered lexically.
    const vectorCovered = new Set<string>();

    for (let i = 0; i < n; i += 1) {
        const va = sidecars[i];
        if (!va) continue;
        for (let j = i + 1; j < n; j += 1) {
            const vb = sidecars[j];
            if (!vb) continue;
            vectorCovered.add(`${i}:${j}`);
            if (sameComponent(i, j)) continue;
            const d = hammingDistance(va, vb);
            if (d < 0 || d > maxHamming) continue;
            const [aId, bId] = pairOf(i, j);
            vectorPairs.push({ aId, bId, axis: 'vector', hamming: d, similarity: cosineFromHamming(d) });
        }
    }

    // Lexical fallback — only where the vector axis could not decide.
    const tokenSets = items.map((it) => normalizeTitleTokens(it.title));
    for (const [i, j] of lexicalCandidatePairs(tokenSets)) {
        if (vectorCovered.has(`${i}:${j}`)) continue;
        if (sameComponent(i, j)) continue;
        const jac = titleJaccard(tokenSets[i], tokenSets[j]);
        if (jac < lexicalLowerBound || jac >= TITLE_JACCARD_PROPAGATION_THRESHOLD) continue;
        const [aId, bId] = pairOf(i, j);
        lexicalPairs.push({ aId, bId, axis: 'lexical', hamming: null, similarity: jac });
    }

    vectorPairs.sort(
        (a, b) => (a.hamming as number) - (b.hamming as number) || cmpIds(a, b),
    );
    lexicalPairs.sort((a, b) => b.similarity - a.similarity || cmpIds(a, b));

    const all = vectorPairs.concat(lexicalPairs);
    return { pairs: all.slice(0, maxPairs), foundCount: all.length, withSidecar };
}

/** Total order on ids so equal-distance pairs come back in a stable sequence. */
function cmpIds(a: GrayBandPair, b: GrayBandPair): number {
    if (a.aId !== b.aId) return a.aId < b.aId ? -1 : 1;
    if (a.bId !== b.bId) return a.bId < b.bId ? -1 : 1;
    return 0;
}

/** Flat counters for the diagnostics report. Pure projection of a sweep. */
export interface GrayBandCounters {
    /** Items handed to the sweep. */
    dedupCandidates: number;
    /** Items whose sidecar decoded — the vector axis's real coverage. Today
     *  this is 0 in prod: the column exists and the serve path returns it, but
     *  no article carries one yet. A zero here means "not measured", not
     *  "no duplicates". */
    dedupWithSidecar: number;
    /** Pairs enumerated AFTER the cap — what a downstream step would act on. */
    dedupPairsSent: number;
    /** Pairs before the cap, so a saturated sweep is visible as a shortfall. */
    dedupPairsFound: number;
    dedupPairsVectorAxis: number;
    dedupPairsLexicalAxis: number;
    /** Hamming of the closest vector pair, or -1 when there is none. */
    dedupClosestHamming: number;
}

/**
 * One sweep + its counters. This is what the diagnostics report calls: it never
 * needs the pairs themselves (they carry article ids and would have to be
 * PII-screened before sharing), only the counts.
 */
export function grayBandSweep(
    items: DedupCandidate[],
    opts: GrayBandOptions = {},
): { pairs: GrayBandPair[]; counters: GrayBandCounters } {
    const { pairs, foundCount, withSidecar } = sweepGrayBand(items, opts);
    let vector = 0;
    let closest = -1;
    for (const p of pairs) {
        if (p.axis !== 'vector') continue;
        vector += 1;
        if (closest < 0 || (p.hamming as number) < closest) closest = p.hamming as number;
    }
    return {
        pairs,
        counters: {
            dedupCandidates: items.length,
            dedupWithSidecar: withSidecar,
            dedupPairsSent: pairs.length,
            dedupPairsFound: foundCount,
            dedupPairsVectorAxis: vector,
            dedupPairsLexicalAxis: pairs.length - vector,
            dedupClosestHamming: closest,
        },
    };
}
