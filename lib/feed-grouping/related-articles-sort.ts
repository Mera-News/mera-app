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
 *   1. Tier A — the CURRENT article's country. Always first, even when it holds
 *      one row and another country holds twenty. That country is then excluded
 *      from tier B, so it never renders as a second block.
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
 * Contiguity invariant: all rows of a given country are adjacent, because
 * alpha-3 is a full tiebreak after size and rank — two distinct countries can
 * never compare equal.
 *
 * A `null` context degrades the language key and every `countryRank` to its
 * "last" bucket, so size ordering still applies and ties fall to alpha-3.
 * Never throws.
 */

import {
    baseLang,
    countryRank,
    normAlpha3,
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
 * Return a NEW array of `items` ordered into contiguous per-country blocks —
 * the current article's country first, then the remaining countries biggest-block
 * first, then the countryless rows; see the module header for the full key order.
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
): T[] {
    const current = normAlpha3(currentCountryAlpha3);
    const blocks = buildCountryBlocks(items, ctx);

    return [...items].sort((a, b) => {
        // 1. Country block: current country, then biggest block, then countryless.
        const ka = countryBlockKey(a, current, blocks);
        const kb = countryBlockKey(b, current, blocks);
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

        // From here both rows are in the SAME block — order within it.

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
    });
}
