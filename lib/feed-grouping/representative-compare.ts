/**
 * The ONE representative comparator every feed surface elects its story
 * front-runner with.
 *
 * This was previously duplicated byte-identically in `lib/stores/feed-list-selector.ts`
 * and `lib/stores/fact-rows-selector.ts` — each carrying a comment asserting the
 * other copy must stay identical, which is exactly the friction that justifies a
 * shared module: the assertion could only be maintained by hand, and any change
 * had to be applied twice or the Feed and the Dashboard would silently front
 * different articles for the same story.
 *
 * Pure functions only — NO imports from React Native, WatermelonDB, Zustand
 * stores, or the logger (same purity contract as `story-grouping.ts` /
 * `geo-language-priority.ts`). In particular it deliberately does NOT import
 * `ForYouSuggestion` from `lib/stores/for-you-store`, which drags in the SQLite
 * adapter at module load; it declares the minimal structural shape instead, so
 * both selectors' `GroupItem` types satisfy it without any cast.
 */

import {
    repPriorityTier,
    sourcePriorityTier,
    type UserGeoLanguageContext,
} from './geo-language-priority';

/** The minimal suggestion shape representative election reads. Both selectors'
 *  `ForYouSuggestion` satisfies this structurally. */
export interface RepresentativeSortable {
    /** Stable suggestion identity — the final deterministic tiebreak. */
    _id: string;
    /** First-published ISO timestamp. Unparseable/absent parses to 0. */
    firstPubDate: string | null;
    /** Final post-judge raw score; null = unscored (ranks last on that key). */
    rawScore: number | null;
    publication_name: string | null;
    /** Publishing country, ISO alpha-3. */
    country_code: string | null;
    language_code: string | null;
    /** Lead image URL. Absent/null/blank ⇒ the article has no image. Optional so
     *  callers with leaner projections keep compiling; see `hasImage`. */
    image_url?: string | null;
}

/** A story-group member as both selectors model it: the grouping item with the
 *  underlying suggestion hung off `.s`. */
export interface RepresentativeGroupItem {
    s: RepresentativeSortable;
}

function parseMs(iso: string | null | undefined): number {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
}

/**
 * Does this article carry a usable lead image? A non-empty (post-trim)
 * `image_url` and nothing more — this is an ordering key, not a validator, so it
 * deliberately does not inspect the scheme or try to reach the URL.
 *
 * INTERACTION, NOT A BUG: a separate wave nulls INSECURE (non-https) image URLs
 * at ingest. Those rows therefore arrive here with `image_url === null` and are
 * demoted by this key exactly as if the publisher had shipped no image at all.
 * That is the intended outcome — an image the app will refuse to render is not
 * an image — but it does mean a representative can change purely because the
 * ingest-side URL policy changed, with no edit to this comparator. Do not chase
 * that as a regression here.
 */
export function hasImage(s: RepresentativeSortable): boolean {
    return (s.image_url ?? '').trim() !== '';
}

/**
 * Tail of the representative comparator, once the tier keys have tied:
 * `hasImage` → OLDEST `firstPubDate` → higher `rawScore` → smaller `_id`.
 * (Standard sort order: negative ⇒ `a` preferred.)
 *
 * `firstPubDate` is ASCENDING by design. A story's oldest member is the
 * ORIGINATING report; its newest is typically an aggregator's rewrite of that
 * same report. Fronting the original is both fairer to the outlet that did the
 * work and, in practice, the fuller piece — the group's freshness is unaffected,
 * since the story is still admitted and ranked on the whole group (see
 * `feed-list-selector`'s D4 note).
 *
 * ASC does invert one degenerate case: `parseMs` maps an absent/unparseable date
 * to 0, which used to sink such a row and now floats it to the front. That is
 * unreachable in production — `article-suggestion-service.toForYouSuggestion`
 * builds `firstPubDate` as `row.firstPubDate.toISOString()` off a NON-optional
 * `@date` column, so a corrupt value throws at projection time and never reaches
 * this comparator. It is left as-is (rather than mirroring
 * `related-articles-sort`, which deliberately trails undated rows) because only
 * fixtures can produce it, and pushing 0 to the tail would add a branch no
 * shipped row can take.
 */
function repCompare(a: RepresentativeGroupItem, b: RepresentativeGroupItem): number {
    const ia = hasImage(a.s);
    const ib = hasImage(b.s);
    if (ia !== ib) return ia ? -1 : 1;
    const pa = parseMs(a.s.firstPubDate);
    const pb = parseMs(b.s.firstPubDate);
    if (pa !== pb) return pa - pb;
    const ra = a.s.rawScore ?? Number.NEGATIVE_INFINITY;
    const rb = b.s.rawScore ?? Number.NEGATIVE_INFINITY;
    if (ra !== rb) return rb - ra;
    return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

/**
 * Build the tier-aware representative comparator, in four keys:
 *
 *   1. `sourcePriorityTier` — the user's EXPLICIT source preferences
 *      (preferred publication → preferred country scope → rest). This is the
 *      literal ask: "when a story has an article from a source I prefer, that
 *      should be the one used." An explicit request outranks every derived
 *      signal, so it is compared FIRST.
 *   2. `repPriorityTier` — the derived geo/language priority (home country →
 *      other user country → app language → rest).
 *   3. `hasImage` — an illustrated article fronts an unillustrated one.
 *   4. `repCompare`'s tail — oldest `firstPubDate` → rawScore → `_id`.
 *
 * WHY `hasImage` SITS AT 3, NOT AT 1: the server's own `pickRepresentative`
 * ranks `hasImage` first, and this ordering deliberately moves the app closer to
 * that without adopting it wholesale. Keys 1 and 2 are USER-SPECIFIC — a source
 * the user named, or their own country/language — and must not lose to a stock
 * photo on some other outlet's rewrite. Language preference is already fully
 * expressed by those two tiers, which is why neither is touched here.
 *
 * A `null` `userCtx` collapses every item to source tier 2 and geo tier 3, so
 * election falls through to keys 3–4 alone. So does a context with no source
 * preferences, for key 1.
 *
 * This changes only WHICH article fronts a group, never where the group sits in
 * a list — see the D4 note in `feed-list-selector.buildFeedList` (and the
 * asymmetry note on the Dashboard's `cardCompare`, which orders on the elected
 * representative's `createdAt` and so DOES still move when election changes).
 */
export function makeRepCompare(
    userCtx: UserGeoLanguageContext | null,
): (a: RepresentativeGroupItem, b: RepresentativeGroupItem) => number {
    return (a, b) => {
        const sa = sourcePriorityTier(
            { publicationName: a.s.publication_name, countryCodeAlpha3: a.s.country_code },
            userCtx,
        );
        const sb = sourcePriorityTier(
            { publicationName: b.s.publication_name, countryCodeAlpha3: b.s.country_code },
            userCtx,
        );
        if (sa !== sb) return sa - sb;
        const ta = repPriorityTier(
            { countryCodeAlpha3: a.s.country_code, languageCode: a.s.language_code },
            userCtx,
        );
        const tb = repPriorityTier(
            { countryCodeAlpha3: b.s.country_code, languageCode: b.s.language_code },
            userCtx,
        );
        if (ta !== tb) return ta - tb;
        return repCompare(a, b);
    };
}
