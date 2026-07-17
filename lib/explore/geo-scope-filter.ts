// Explore tab — on-device geo-tag filter.
//
// City/region scope tabs fetch the COUNTRY's article pages (the same
// `articlesForCountry` query) and filter them here to the scope's place using
// the articles' `geo_tags`. Transient, in-memory only — this deliberately does
// NOT touch the scoring engine (no weights, no wrong-location logic): Explore is
// a raw geographic drill-down, not a personalized feed.
//
// NOTE: geo-tagging is dormant in prod (every `geo_tags` is null), so city/
// region scopes are empty there until activation; staging has ~3.2k tagged
// articles. A null/absent `geo_tags` is treated as "no match".

import type { ExploreScope } from './scopes';

interface GeoTagLike {
    readonly city?: string | null;
    readonly region?: string | null;
    readonly countryCode?: string | null;
}

interface GeoTaggedArticle {
    readonly geo_tags?: readonly GeoTagLike[] | null;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * True when the article's geo tags place it inside the scope.
 * World/country scopes always match (no client-side geo filter — the server's
 * country query already scoped them). City/region scopes match when ANY tag's
 * city (resp. region) equals the scope's place, case-insensitively.
 */
export function articleMatchesScope(
    geoTags: readonly GeoTagLike[] | null | undefined,
    scope: ExploreScope,
): boolean {
    if (scope.kind === 'world' || scope.kind === 'country') return true;
    if (!geoTags || geoTags.length === 0) return false;

    if (scope.kind === 'city') {
        const city = norm(scope.city);
        return city.length > 0 && geoTags.some((tag) => norm(tag.city) === city);
    }

    // region
    const region = norm(scope.region);
    return region.length > 0 && geoTags.some((tag) => norm(tag.region) === region);
}

/**
 * Filter a fetched page down to the rows matching the scope. World/country
 * scopes pass through untouched.
 */
export function filterArticlesForScope<T extends GeoTaggedArticle>(
    articles: readonly T[],
    scope: ExploreScope,
): T[] {
    if (scope.kind === 'world' || scope.kind === 'country') return [...articles];
    return articles.filter((article) => articleMatchesScope(article.geo_tags ?? null, scope));
}
