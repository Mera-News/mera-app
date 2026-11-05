// Publication tags weigh the feed (owner): Preferred ×1.5, Subscribed ×2, a
// stored Fewer ×0.5, Not preferred skips. Subscribed combines with one of the
// others by multiplying (Subscribed + Fewer = 1.0); Not preferred wins at 0.
//
// A preferred country gives its publications ×1.5. A publication with any tag of
// its own keeps that tag's multiplier instead: the two never stack.
//
// RANKING ONLY. The multiplier moves the band a row SORTS in; the chip, the
// visibility gate and the note keep the raw score, so Fewer sinks a story but
// never hides it and Subscribed lifts one but never shows a below-gate one.
// Nothing is persisted: a tag change applies at the next Feed session, from the
// session's context, and undoes cleanly.
//
// Kept out of `lib/algorithms/geo-language-priority.ts` on purpose: that file
// is mirrored by the server's related sort, and this rule is the app's alone.
//
// Pure: no RN, database or store imports.

import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { normAlpha3, normPublicationName, type UserGeoLanguageContext } from '@/lib/algorithms/geo-language-priority';

const PUBLICATION_TAG_MULTIPLIER = { more: 1.5, fewer: 0.5, subscribed: 2 } as const;

export type PublicationPrefTag = 'more' | 'fewer' | 'mute' | null;

/** The geo/language context plus the one map of publication multipliers
 *  (normalised name → multiplier; 0 = muted). An entry of 1 is kept: a tagged
 *  publication's own tags outrank its country. */
export type RankingContext = UserGeoLanguageContext & {
    readonly publicationMultipliers?: ReadonlyMap<string, number>;
};

/** One publication's multiplier from its tags. */
export function publicationTagMultiplier(pref: PublicationPrefTag, subscribed: boolean): number {
    if (pref === 'mute') return 0;
    const m = PUBLICATION_TAG_MULTIPLIER;
    const prefM = pref === 'more' ? m.more : pref === 'fewer' ? m.fewer : 1;
    return (subscribed ? m.subscribed : 1) * prefM;
}

/** The multiplier a publication's own tags give it; undefined when it has none. */
function namedMultiplier(
    publicationName: string | null | undefined,
    ctx: RankingContext | null | undefined,
): number | undefined {
    const key = normPublicationName(publicationName);
    return key === null ? undefined : ctx?.publicationMultipliers?.get(key);
}

/** The part of a row the sort weighs. */
export type RankedRow = {
    readonly publication_name: string | null | undefined;
    /** Alpha-3, or null. */
    readonly country_code: string | null | undefined;
};

function isPreferredCountry(countryCode: string | null | undefined, ctx: RankingContext | null | undefined): boolean {
    const country = normAlpha3(countryCode);
    return country !== null && ctx?.preferredCountriesAlpha3?.has(country) === true;
}

/** Mute means skip: the row leaves every Feed list. */
export function isMutedPublication(
    publicationName: string | null | undefined,
    ctx: RankingContext | null | undefined,
): boolean {
    return namedMultiplier(publicationName, ctx) === 0;
}

/**
 * The relevance a row SORTS by. An EMERGENCY row (above the emergency cutoff)
 * is never weighted, and a weighted row is capped AT the cutoff, so a tag can
 * never make a story an emergency (0.6 × 2 would read as 1.2).
 */
export function rankedRelevance(
    relevance: number,
    row: RankedRow,
    ctx: RankingContext | null | undefined,
    cutoff: number = DEFAULT_HARNESS_CONFIG.articlePipeline.emergencyPriorityCutoff,
): number {
    if (relevance > cutoff) return relevance;
    const m =
        namedMultiplier(row.publication_name, ctx) ??
        (isPreferredCountry(row.country_code, ctx) ? PUBLICATION_TAG_MULTIPLIER.more : 1);
    return m === 1 ? relevance : Math.min(relevance * m, cutoff);
}
