/**
 * Pure country-grouped ordering for the merged, flat "Related Articles" list on
 * the article/suggestion detail screens.
 *
 * Pure functions only — NO imports from React Native, WatermelonDB, Zustand
 * stores, or the logger (same purity contract as `story-grouping.ts` /
 * `geo-language-priority.ts`). It only depends on the geo/language helpers in
 * `geo-language-priority.ts`.
 *
 * The detail screens merge local cluster siblings and the server
 * `relatedArticles` list into ONE flat section (no group headers). Reading
 * coverage of a story is easiest when each country's rows sit together, so this
 * util orders the list into contiguous per-country blocks — grouping is purely
 * an ordering property, nothing is sectioned:
 *
 *   0. Tier P (source-pref) — rows from a source the user EXPLICITLY prefers,
 *      ordered preferred-publication before preferred-country-scope. This is the
 *      literal product ask: "preferred sources should be at the top when
 *      available." A preferred row LIFTS OUT of its country block to the head of
 *      the list, so it is visible without scrolling past whichever country
 *      happens to own the biggest block. Empty unless the user has said so.
 *   1. Tier A — the CURRENT article's country. Always first among the country
 *      blocks, even when it holds one row and another country holds twenty. That
 *      country is then excluded from tier B, so it never renders as a second
 *      block.
 *   2. Tier B — every other known country, by block size DESC (biggest coverage
 *      first), ties broken by `countryRank` (the user's home country, then their
 *      other ranked countries), then alpha-3 alphabetical.
 *   3. Tier C — rows with no country, trailing.
 *
 * WITHIN one block (and within tier C) the original tail keys still decide:
 *
 *   4. Language — the user's app-language base first, then the other languages
 *      alphabetical by base code, then null/unknown last.
 *   5. Publication name — case-insensitive alphabetical, null/empty last.
 *   6. `pubDateMs` DESC (newest first), then `id` ASC (final deterministic tiebreak).
 *
 * Block size is a property of the SET, not of a pair, so a bare comparator can't
 * express it — sizes (and each country's rank) are precomputed in one O(n) pass
 * and the comparator closes over that map. Caching the rank there also keeps
 * `countryRank` (which allocates) out of the per-comparison path.
 *
 * Contiguity invariant (updated by source-pref): all rows of a given country
 * that are NOT in tier P are adjacent, because alpha-3 is a full tiebreak after
 * size and rank — two distinct countries can never compare equal. Tier P is the
 * one deliberate exception: it is a cross-country head block, so a country with
 * a preferred source renders in two places (its preferred rows at the top, the
 * rest in their own block). That is the point of the feature — a user who asked
 * for the Times of India wants it first, not filed under IND.
 *
 * Block SIZES are counted over the rows that actually remain in the country
 * blocks — rows lifted into tier P are excluded from `buildCountryBlocks`.
 * Counting them would let a source preference silently reorder tier B (a country
 * could out-rank another on the strength of rows that no longer render there),
 * turning a "lift these to the top" request into a wholesale reshuffle.
 *
 * A `null` context degrades the language key and every `countryRank` to its
 * "last" bucket and empties tier P, so size ordering still applies and ties fall
 * to alpha-3. So does a context carrying no source preferences. Never throws.
 */

import {
    baseLang,
    countryRank,
    normAlpha3,
    sourcePriorityTier,
    type UserGeoLanguageContext,
} from './geo-language-priority';

/** The minimal shape a related-article entry must expose to be sortable. */
export interface RelatedSortable {
    /** Stable identity — the final deterministic tiebreak. */
    id: string;
    /** Article/publication language code (may be a full tag like `zh-Hans`). Null when unknown. */
    languageCode: string | null;
    /** Publishing country, ISO alpha-3. Null when unknown. */
    countryCodeAlpha3: string | null;
    /** Publication display name. Null/empty sorts last. */
    publicationName: string | null;
    /** First-published time in epoch ms; higher = newer. NaN/null sorts as oldest. */
    pubDateMs: number | null;
}

/**
 * How `orderRelatedArticles` should order the list.
 *
 * - `'relevance'` (DEFAULT) — the full tiered ordering described in the module
 *   header: preferred sources → current article's country → other countries by
 *   block size → countryless, then language → publication → date DESC → id.
 *   This is the only mode that consults the user's context at all.
 * - `'oldest'` — a FLAT publish-date ASCENDING sort. Every tier above is
 *   deliberately bypassed: the user asked to read the coverage in the order it
 *   was published, and interleaving country blocks would defeat that.
 * - `'newest'` — the same flat sort, publish date DESCENDING.
 *
 * In BOTH date modes, rows with an unknown publish date (`null`/`NaN`) sort
 * LAST, not merely at the numeric extreme — so `'oldest'` is not the exact
 * reverse of `'newest'`. An undated row is not evidence of being early; putting
 * it at the head of "oldest first" would assert something the data does not say.
 * `id` ASC is the final tiebreak in every mode.
 */
export type RelatedSortMode = 'relevance' | 'oldest' | 'newest';

/** Per-country facts precomputed once over the whole list. */
interface CountryBlock {
    /** How many rows in the list carry this country. */
    size: number;
    /** `countryRank` against the user's context; `Infinity` when unranked. */
    rank: number;
}

/**
 * Count the rows per country (alpha-3, nulls skipped) and cache each country's
 * `countryRank` alongside. One O(n) pass; the comparator reads this map instead
 * of recomputing per comparison.
 */
function buildCountryBlocks(
    items: readonly RelatedSortable[],
    ctx: UserGeoLanguageContext | null,
): Map<string, CountryBlock> {
    const blocks = new Map<string, CountryBlock>();
    for (const item of items) {
        // Rows lifted into tier P do not render in a country block, so they must
        // not count towards one — see the header's note on why counting them
        // would let a preference reshuffle tier B.
        if (sourceTierOf(item, ctx) !== null) {
            continue;
        }
        const a3 = normAlpha3(item.countryCodeAlpha3);
        if (a3 === null) {
            continue;
        }
        const existing = blocks.get(a3);
        if (existing === undefined) {
            blocks.set(a3, { size: 1, rank: countryRank(a3, ctx) });
        } else {
            existing.size += 1;
        }
    }
    return blocks;
}

// --- Per-key ranking helpers (each returns a { group, tiebreak } shape) -----

/**
 * The source-preference tier that LIFTS a row into tier P, or `null` when the
 * row stays in its country block. `0` = a publication the user named, `1` = a
 * country scope they asked for; `sourcePriorityTier`'s `2` ("neither") is the
 * non-lifting case and maps to `null` here so every caller reads it as "not
 * preferred" rather than as a third head-block rank.
 */
function sourceTierOf(
    item: RelatedSortable,
    ctx: UserGeoLanguageContext | null,
): 0 | 1 | null {
    const tier = sourcePriorityTier(
        { publicationName: item.publicationName, countryCodeAlpha3: item.countryCodeAlpha3 },
        ctx,
    );
    return tier === 2 ? null : tier;
}

/**
 * Country-block key: tier 0 = the current article's country, 1 = another known
 * country (ordered size DESC → rank ASC → alpha-3), 2 = null/unknown (last).
 * `size`/`rank`/`a3` are consulted for tier 1 only.
 */
function countryBlockKey(
    item: RelatedSortable,
    currentCountryAlpha3: string | null,
    blocks: Map<string, CountryBlock>,
): { tier: number; size: number; rank: number; a3: string } {
    const a3 = normAlpha3(item.countryCodeAlpha3);
    if (a3 === null) {
        return { tier: 2, size: 0, rank: 0, a3: '' };
    }
    if (currentCountryAlpha3 !== null && a3 === currentCountryAlpha3) {
        return { tier: 0, size: 0, rank: 0, a3: '' };
    }
    const block = blocks.get(a3);
    return {
        tier: 1,
        size: block?.size ?? 0,
        rank: block?.rank ?? Infinity,
        a3,
    };
}

/**
 * Language key: group 0 = user's app language, 1 = another known language
 * (ordered alphabetical by base), 2 = null/unknown. `base` is the tiebreak
 * within group 1 only.
 */
function languageKey(
    item: RelatedSortable,
    ctx: UserGeoLanguageContext | null,
): { group: number; base: string } {
    const base = baseLang(item.languageCode);
    if (base === null) {
        return { group: 2, base: '' };
    }
    if (ctx !== null && ctx.appLanguageBase !== null && base === ctx.appLanguageBase) {
        return { group: 0, base };
    }
    return { group: 1, base };
}

/** Publication key: group 0 = a non-empty name (case-insensitive), 1 = null/empty (last). */
function publicationKey(item: RelatedSortable): { group: number; name: string } {
    const trimmed = (item.publicationName ?? '').trim();
    if (trimmed === '') {
        return { group: 1, name: '' };
    }
    return { group: 0, name: trimmed.toLowerCase() };
}

/** Epoch-ms for the date tiebreak; null/NaN treated as oldest (`-Infinity`). */
function dateMs(item: RelatedSortable): number {
    const ms = item.pubDateMs;
    return ms === null || Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Flat publish-date ordering for the `'oldest'` / `'newest'` modes. Undated rows
 * are pushed to the tail in BOTH directions (see `RelatedSortMode`), then `id`
 * ASC settles the rest.
 */
function compareByDate(
    a: RelatedSortable,
    b: RelatedSortable,
    ascending: boolean,
): number {
    const da = a.pubDateMs;
    const db = b.pubDateMs;
    const ua = da === null || da === undefined || Number.isNaN(da);
    const ub = db === null || db === undefined || Number.isNaN(db);
    if (ua !== ub) return ua ? 1 : -1; // undated last, either direction
    if (!ua && !ub && da !== db) {
        return ascending ? (da as number) - (db as number) : (db as number) - (da as number);
    }
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
}

/**
 * Return a NEW array of `items` ordered according to `mode`.
 *
 * In the default `'relevance'` mode the result is contiguous per-country blocks —
 * the current article's country first, then the remaining countries biggest-block
 * first, then the countryless rows; see the module header for the full key order.
 * `'oldest'` / `'newest'` replace all of that with a flat publish-date sort (see
 * `RelatedSortMode`), and ignore `currentCountryAlpha3` and `ctx` entirely.
 *
 * `currentCountryAlpha3` is the country of the article being viewed (any case /
 * whitespace; normalized here). Null/unknown simply leaves tier A empty.
 *
 * Non-mutating (the input is never reordered in place). Deterministic for a given
 * input. Never throws.
 */
export function orderRelatedArticles<T extends RelatedSortable>(
    items: T[],
    currentCountryAlpha3: string | null,
    ctx: UserGeoLanguageContext | null,
    mode: RelatedSortMode = 'relevance',
): T[] {
    if (mode === 'oldest' || mode === 'newest') {
        return [...items].sort((a, b) => compareByDate(a, b, mode === 'oldest'));
    }

    const current = normAlpha3(currentCountryAlpha3);
    const blocks = buildCountryBlocks(items, ctx);

    return [...items].sort((a, b) => {
        // 0. Tier P — preferred sources lift to the head of the list, ordered
        //    named-publication (0) before country-scope (1). Rows that are not
        //    preferred (null) fall through to the country blocks below. Encoded
        //    as -1/0 vs 1 so a preferred row always sorts ahead of every country
        //    block INCLUDING tier A (the current article's own country).
        const sa = sourceTierOf(a, ctx);
        const sb = sourceTierOf(b, ctx);
        if (sa !== sb) {
            if (sa === null) return 1;
            if (sb === null) return -1;
            return sa - sb;
        }
        // Both rows are now in the same head/country partition. Within tier P
        // the country keys are deliberately SKIPPED — that is what makes it one
        // cross-country block — and ordering falls straight to the within-block
        // keys (language → publication → date → id).
        if (sa === null) {
            // 1. Country block: current country, then biggest block, then countryless.
            const ka = countryBlockKey(a, current, blocks);
            const kb = countryBlockKey(b, current, blocks);
            const countryOrder = compareCountryBlocks(ka, kb);
            if (countryOrder !== 0) return countryOrder;
        }

        return compareWithinBlock(a, b, ctx);
    });
}

/** Country-block ordering — extracted so the tier-P head block can skip it
 *  wholesale rather than threading a flag through every key. Returns 0 when
 *  both rows are in the SAME block. Body is unchanged from the original inline
 *  keys 1a–1c. */
function compareCountryBlocks(
    ka: { tier: number; size: number; rank: number; a3: string },
    kb: { tier: number; size: number; rank: number; a3: string },
): number {
    if (ka.tier !== kb.tier) {
        return ka.tier - kb.tier;
    }
    if (ka.tier === 1) {
        if (ka.size !== kb.size) {
            return kb.size - ka.size; // bigger block first
        }
        // Guarded compare: `rank` is `Infinity` for unranked countries and
        // `Infinity - Infinity` is NaN, which would make `sort` return an
        // arbitrary order and silently break block contiguity.
        if (ka.rank !== kb.rank) {
            return ka.rank - kb.rank;
        }
        if (ka.a3 !== kb.a3) {
            return ka.a3 < kb.a3 ? -1 : 1;
        }
    }
    return 0;
}

/** Ordering WITHIN one block (a country block, or the tier-P head block):
 *  language → publication name → date DESC → id ASC. Body is unchanged from the
 *  original inline keys 2–4. */
function compareWithinBlock(
    a: RelatedSortable,
    b: RelatedSortable,
    ctx: UserGeoLanguageContext | null,
): number {
    // 2. Language.
    const la = languageKey(a, ctx);
    const lb = languageKey(b, ctx);
    if (la.group !== lb.group) {
        return la.group - lb.group;
    }
    if (la.group === 1 && la.base !== lb.base) {
        return la.base < lb.base ? -1 : 1;
    }

    // 3. Publication name.
    const pa = publicationKey(a);
    const pb = publicationKey(b);
    if (pa.group !== pb.group) {
        return pa.group - pb.group;
    }
    if (pa.name !== pb.name) {
        return pa.name < pb.name ? -1 : 1;
    }

    // 4. Date DESC, then id ASC (fully deterministic).
    const da = dateMs(a);
    const db = dateMs(b);
    if (da !== db) {
        return db - da;
    }
    if (a.id !== b.id) {
        return a.id < b.id ? -1 : 1;
    }
    return 0;
}
