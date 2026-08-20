// search-news-service — thin GraphQL wrapper around the server's `searchNews`
// query for Explore's search bar (Item 12a).
//
// `searchNews` is deliberately headline-only (no description, no article_url —
// see the schema comment on `NewsSearchHit`): with no scraped article body in
// this product, title + description IS the article, so returning it unmetered
// would be a paywall bypass. Callers render from exactly what this returns —
// there is no follow-up hydration call to make here.
//
// It is AUTHENTICATED but NOT subscription-gated. It used to carry
// `SubscriptionGuard`; the server removed it deliberately, because search is a
// discovery surface a Mera News Free reader must be able to use — the same
// reader can already browse Explore and open an article. See the reasoning on
// `NewsSearchResolver.searchNews`.
//
// The `'not-subscribed'` branch below is therefore UNREACHABLE today. It is kept
// rather than deleted so that re-adding the guard server-side cannot produce a
// generic "something went wrong" on a paywall, but do not treat its existence
// as evidence that search is gated.
//
// The server is also HYBRID now, not semantic-only: an Atlas Search text leg
// fused with the vector leg by reciprocal rank. Each leg degrades on its own, so
// a provider or index outage shows up as weaker results rather than an error.
//
// Never throws: every failure — network, GraphQL, auth — resolves to
// `{ ok: false, kind }` so callers never need a try/catch of their own.

import { gql } from '@apollo/client';
import client from '@/lib/apollo-client';
import logger from '@/lib/logger';
import type { NewsSearchHit } from '@/lib/generated/graphql-types';
import { isNotSubscribedError } from '@/lib/subscription/not-subscribed-error';

/**
 * Client-side floor. This is OURS, not the server's — `searchNews` rejects only
 * an empty query. It exists so a single character does not spend a round trip
 * (and, on a cache miss, a paid embedding call) on a query that cannot be
 * meaningful. Enforced twice on purpose: here, and in `useNewsSearch` so the
 * panel clears the instant the user deletes back below it.
 */
export const SEARCH_NEWS_MIN_QUERY_LENGTH = 2;

/** Server-side cap on `searchNews` results (see schema.gql / server resolver). */
export const SEARCH_NEWS_MAX_RESULTS = 25;

const SEARCH_NEWS = gql`
  query SearchNews($query: String!, $limit: Int) {
    searchNews(query: $query, limit: $limit) {
      _id
      title_en
      image_url
      publication_name
      country_code
      pubDate
      score
    }
  }
`;

export type NewsSearchErrorKind = 'not-subscribed' | 'unknown';

export type NewsSearchResult =
  | { readonly ok: true; readonly hits: NewsSearchHit[] }
  | { readonly ok: false; readonly kind: NewsSearchErrorKind };

/**
 * Run the search. `query` is trimmed here as well as by callers — a query that
 * trims below `SEARCH_NEWS_MIN_QUERY_LENGTH` resolves to an empty success
 * rather than round-tripping to a server that would reject it anyway.
 */
export async function searchNews(
  query: string,
  limit: number = SEARCH_NEWS_MAX_RESULTS,
): Promise<NewsSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length < SEARCH_NEWS_MIN_QUERY_LENGTH) {
    return { ok: true, hits: [] };
  }

  try {
    const { data } = await client.query<{ searchNews: NewsSearchHit[] }>({
      query: SEARCH_NEWS,
      variables: { query: trimmed, limit },
      fetchPolicy: 'no-cache',
    });
    return { ok: true, hits: data?.searchNews ?? [] };
  } catch (error) {
    const kind: NewsSearchErrorKind = isNotSubscribedError(error) ? 'not-subscribed' : 'unknown';
    // A 402 here is Mera News Free working as designed, same as the other
    // guarded AI queries — a breadcrumb is enough, not a Sentry exception.
    if (kind === 'not-subscribed') {
      logger.addBreadcrumb(
        '[news-search-service] searchNews NOT_SUBSCRIBED',
        'news-search',
        { queryLength: trimmed.length },
        'warning',
      );
    } else {
      logger.captureException(error, {
        tags: { service: 'news-search-service', method: 'searchNews' },
        extra: { queryLength: trimmed.length },
      });
    }
    return { ok: false, kind };
  }
}
