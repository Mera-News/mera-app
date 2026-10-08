// Publication tags weigh the feed (owner): More ×1.5, Subscribed ×2, Fewer ×0.5,
// Mute skips. Subscribed combines with one of the other three by multiplying
// (Subscribed + Fewer = 1.0); Mute wins at 0.
//
// RANKING ONLY. The multiplier moves the band a row SORTS in; the chip, the
// visibility gate and the note keep the raw score, so Fewer sinks a story but
// never hides it and Subscribed lifts one but never shows a below-gate one.
// Nothing is persisted: a tag change applies at the next Feed session, from the
// session's context, and undoes cleanly.
//
// Kept out of `lib/feed-grouping/geo-language-priority.ts` on purpose: that file
// is mirrored by the server's related sort, and this rule is the app's alone.
//
// Pure: no RN, database or store imports.

import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { normPublicationName, type UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';

export const PUBLICATION_TAG_MULTIPLIER = { more: 1.5, fewer: 0.5, subscribed: 2 } as const;

export type PublicationPrefTag = 'more' | 'fewer' | 'mute' | null;

/** The geo/language context plus the one map of publication multipliers
 *  (normalised name → multiplier; 0 = muted; absent = 1). */
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

/** The multiplier for an article's publication name; 1 without a context. */
export function publicationMultiplier(
    publicationName: string | null | undefined,
    ctx: RankingContext | null | undefined,
): number {
    const map = ctx?.publicationMultipliers;
    if (!map || map.size === 0) return 1;
    const key = normPublicationName(publicationName);
    return key === null ? 1 : map.get(key) ?? 1;
}

/** Mute means skip: the row leaves every Feed list. */
export function isMutedPublication(
    publicationName: string | null | undefined,
    ctx: RankingContext | null | undefined,
): boolean {
    return publicationMultiplier(publicationName, ctx) === 0;
}

/**
 * The relevance a row SORTS by. An EMERGENCY row (above the emergency cutoff)
 * is never weighted, and a weighted row is capped AT the cutoff, so a tag can
 * never make a story an emergency (0.6 × 2 would read as 1.2).
 */
export function rankedRelevance(
    relevance: number,
    publicationName: string | null | undefined,
    ctx: RankingContext | null | undefined,
    cutoff: number = DEFAULT_HARNESS_CONFIG.articlePipeline.emergencyPriorityCutoff,
): number {
    if (relevance > cutoff) return relevance;
    const m = publicationMultiplier(publicationName, ctx);
    return m === 1 ? relevance : Math.min(relevance * m, cutoff);
}
