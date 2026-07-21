/**
 * Pure multi-key sort for the merged, flat "Related Articles" list on the
 * article/cluster detail screens.
 *
 * Pure functions only — NO imports from React Native, WatermelonDB, Zustand
 * stores, or the logger (same purity contract as `story-grouping.ts` /
 * `geo-language-priority.ts`). It only depends on the geo/language helpers in
 * `geo-language-priority.ts`.
 *
 * The detail screens merge local cluster siblings and the server
 * `relatedArticles` list into ONE flat section (no group headers). This util
 * orders that section by the user's own signals first, then falls back to a
 * fully deterministic tiebreak so the same input always renders in the same
 * order. Sort key order (each fully decides before the next is consulted):
 *
 *   1. Language — the user's app-language base first, then the other languages
 *      alphabetical by base code, then null/unknown last.
 *   2. Country — `countryRank` (home, then the user's ranked countries), then
 *      the unranked countries alphabetical by alpha-3, then null last.
 *   3. Publication name — case-insensitive alphabetical, null/empty last.
 *   4. `pubDateMs` DESC (newest first), then `id` ASC (final deterministic tiebreak).
 *
 * A `null` context degrades every geo/language key to its "last" bucket, so the
 * list falls back to publication → date → id — stable and legacy-safe.
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

// --- Per-key ranking helpers (each returns a { group, tiebreak } shape) -----

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

/**
 * Country key: group 0 = a country the user is ranked for (ordered by
 * `countryRank`), 1 = another known country (ordered alphabetical by alpha-3),
 * 2 = null/unknown. `rank`/`a3` are the within-group tiebreaks.
 */
function countryKey(
    item: RelatedSortable,
    ctx: UserGeoLanguageContext | null,
): { group: number; rank: number; a3: string } {
    const rank = countryRank(item.countryCodeAlpha3, ctx);
    if (rank !== Infinity) {
        return { group: 0, rank, a3: '' };
    }
    const a3 = normAlpha3(item.countryCodeAlpha3);
    if (a3 !== null) {
        return { group: 1, rank: 0, a3 };
    }
    return { group: 2, rank: 0, a3: '' };
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
 * Build the related-articles comparator for a given user context. Standard sort
 * order (negative → `a` before `b`). Exposed so a call site can reuse it (e.g.
 * merging into another comparator); most callers should use
 * {@link sortRelatedArticles}.
 */
export function makeRelatedComparator<T extends RelatedSortable>(
    ctx: UserGeoLanguageContext | null,
): (a: T, b: T) => number {
    return (a, b) => {
        // 1. Language.
        const la = languageKey(a, ctx);
        const lb = languageKey(b, ctx);
        if (la.group !== lb.group) {
            return la.group - lb.group;
        }
        if (la.group === 1 && la.base !== lb.base) {
            return la.base < lb.base ? -1 : 1;
        }

        // 2. Country.
        const ca = countryKey(a, ctx);
        const cb = countryKey(b, ctx);
        if (ca.group !== cb.group) {
            return ca.group - cb.group;
        }
        if (ca.group === 0 && ca.rank !== cb.rank) {
            return ca.rank - cb.rank;
        }
        if (ca.group === 1 && ca.a3 !== cb.a3) {
            return ca.a3 < cb.a3 ? -1 : 1;
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
    };
}

/**
 * Return a NEW array of `items` sorted by the priority keys above. Non-mutating
 * (the input is never reordered in place). Deterministic for a given input.
 * Never throws.
 */
export function sortRelatedArticles<T extends RelatedSortable>(
    items: T[],
    ctx: UserGeoLanguageContext | null,
): T[] {
    return [...items].sort(makeRelatedComparator<T>(ctx));
}
