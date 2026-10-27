import type { RelatedArticleFacets } from '@/lib/generated/graphql-types';

/**
 * The number beside the "Related coverage" heading, or null to show none.
 *
 * `local` is what the page renders itself (those ids are sent as excludeIds, so
 * the server never counts them again). Two exact-enough sources:
 *  - the list is at its end: what is on screen, so the heading agrees with the
 *    rows (the facet sum counts cached keys the hydrator may later drop);
 *  - otherwise the facet sum, lower bound over rows with no country or
 *    language, but only while the facets were fetched under the exclusion set
 *    the page has now (else they include rows now rendered locally).
 * No chips ship yet, so the filter-aware sums are not needed.
 */
export function relatedHeadingCount(input: {
    local: number;
    served: number;
    hasNextPage: boolean;
    error: boolean;
    loading: boolean;
    facets: RelatedArticleFacets | null;
    facetsExcludeKey: string;
    excludeKey: string;
}): number | null {
    const { local, served, hasNextPage, error, loading, facets, facetsExcludeKey, excludeKey } = input;
    if (loading || error) return null;
    const total = (rows: readonly { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    let n: number | null = null;
    if (!hasNextPage && served > 0) n = local + served;
    else if (facets && facetsExcludeKey === excludeKey) {
        n = local + Math.max(total(facets.countries), total(facets.languages));
    }
    return n && n > 0 ? n : null;
}
