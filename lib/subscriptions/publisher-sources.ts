import { gql } from '@apollo/client';

import client from '../apollo-client';
import logger from '../logger';

/**
 * Resolves every `PublicationSource` belonging to one publisher.
 *
 * WHY THIS EXISTS, and why `searchPublishers.matchingSources` cannot be used
 * instead: `matchingSources` is deliberately the FILTERED subset whose name or
 * URL matched the search string (see the server's `PublisherSearchHit` doc
 * comment and `news-publisher.service.ts`). A publisher that matched on its
 * own `name` or `website_url` alone comes back with `matchingSources: []`.
 * Storing that as the subscription's source-name set would silently match no
 * articles at all, which is the exact failure `source_names_json` exists to
 * prevent.
 *
 * This query has no other caller in the app, which is why it lives here beside
 * the only feature that needs it rather than in `lib/source-service.ts`.
 */
const PUBLICATION_SOURCES_FOR_PUBLISHER = gql`
  query PublicationSourcesForNewsPublisher($publisherId: ID!) {
    publicationSourcesForNewsPublisher(publisherId: $publisherId) {
      publicationSources {
        _id
        publication_name
      }
    }
  }
`;

interface PublisherSourcesResponse {
  readonly publicationSourcesForNewsPublisher: {
    readonly publicationSources: readonly {
      readonly _id: string;
      readonly publication_name: string;
    }[];
  } | null;
}

/**
 * Every source name for a publisher, raw (the caller normalises).
 *
 * Returns `[]` rather than throwing when the query fails. A subscription with
 * an empty source set is recoverable: it matches nothing until the next
 * opportunistic refresh on the subscriptions screen, which is far better than
 * failing the whole "I subscribe to this" action the user just took.
 */
export async function fetchPublisherSourceNames(publisherId: string): Promise<string[]> {
  if (!publisherId) return [];
  try {
    const { data } = await client.query<PublisherSourcesResponse>({
      query: PUBLICATION_SOURCES_FOR_PUBLISHER,
      variables: { publisherId },
      // The set is written into a durable row and re-read from there, so a
      // cached answer here would just be a stale row for the whole lifetime
      // of the subscription.
      fetchPolicy: 'no-cache',
    });
    const sources = data?.publicationSourcesForNewsPublisher?.publicationSources ?? [];
    return sources
      .map((s) => s.publication_name)
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publisher-sources', method: 'fetchPublisherSourceNames' },
      extra: { publisherId },
    });
    return [];
  }
}

/**
 * The source-name set to store for a publisher.
 *
 * The publisher's own name is included as a fallback so a publisher whose
 * sources fail to resolve still matches articles that happen to carry the
 * publisher name verbatim. It is a floor, not the mechanism.
 */
export async function resolveSubscriptionSourceNames(
  publisherId: string,
  publisherName: string,
): Promise<string[]> {
  const fetched = await fetchPublisherSourceNames(publisherId);
  return publisherName ? [...fetched, publisherName] : fetched;
}
