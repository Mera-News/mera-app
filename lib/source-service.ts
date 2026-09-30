import { gql } from '@apollo/client';
import client from './apollo-client';
import {
    NewsPublisher,
    NewsPublishersResponse,
    PublicationSource,
    PublisherSearchHit,
    SearchPublishersResponse,
} from './generated/graphql-types';
import logger from './logger';
import { rememberPublisherSourceNames } from './database/services/publisher-source-names';

const GET_NEWS_PUBLISHERS = gql`
  query GetNewsPublishers(
    $countryCode: String
    $first: Int
    $after: String
  ) {
    newsPublishers(
      countryCode: $countryCode
      first: $first
      after: $after
    ) {
      newsPublishers {
        _id
        name
        website_url
        country_code
        # The publisher's OWN subscribe page. Already on the NewsPublisher
        # type and already selected by SEARCH_PUBLISHERS below; selecting it
        # here too is what lets the Sources publisher list offer it without a
        # second request. Null is a first-class value meaning the publisher
        # has no consumer subscription product.
        subscription_uri
        # Every source of the publisher. Its NAMES key more/fewer (a
        # preference is written under each source name, which is what the
        # scorer matches), so they are recorded on arrival. No feed URL: the
        # app shows no feeds.
        publicationSources {
          _id
          publication_name
          category
          publication_type
          categories
          detected_language_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
    }
  }
`;

const SEARCH_PUBLISHERS = gql`
  query SearchPublishers(
    $query: String!
    $first: Int
    $after: String
  ) {
    searchPublishers(query: $query, first: $first, after: $after) {
      publishers {
        _id
        name
        website_url
        country_code
        country_name
        subscription_uri
        matchingSources {
          _id
          publication_name
          category
          publication_type
          categories
          detected_language_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
    }
  }
`;

export type {
    PublicationSource,
    NewsPublisher,
    NewsPublishersResponse,
    PublisherSearchHit,
    SearchPublishersResponse,
};

export class SourceService {
    static async getNewsPublishers(options?: {
        countryCode?: string;
        first?: number;
        after?: string;
    }): Promise<NewsPublishersResponse> {
        try {
            const { data } = await client.query<{ newsPublishers: NewsPublishersResponse }>({
                query: GET_NEWS_PUBLISHERS,
                variables: {
                    countryCode: options?.countryCode,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            for (const publisher of data?.newsPublishers?.newsPublishers ?? []) {
                rememberPublisherSourceNames(
                    publisher._id,
                    (publisher.publicationSources ?? []).map((s) => s.publication_name),
                );
            }
            return data?.newsPublishers || {
                newsPublishers: [],
                pageInfo: {
                    endCursor: null,
                    hasNextPage: false,
                    pageSize: options?.first ?? 20,
                },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'source-service', method: 'getNewsPublishers' },
                extra: { options },
            });
            throw error;
        }
    }

    /**
     * Publisher/website search (Item 8, Sources L1). `matchingSources` is the
     * FILTERED subset whose name matched the query: good for resolving a name
     * to its publisher (publisher-lookup.ts), never a publisher's full source
     * set, so it is not recorded in publisher-source-names. The
     * server rejects queries shorter than 2 characters — callers must not
     * fire below that length (SourcesL1CountryList debounces and gates on it).
     */
    static async searchPublishers(options: {
        query: string;
        first?: number;
        after?: string;
    }): Promise<SearchPublishersResponse> {
        try {
            const { data } = await client.query<{ searchPublishers: SearchPublishersResponse }>({
                query: SEARCH_PUBLISHERS,
                variables: {
                    query: options.query,
                    first: options.first ?? 20,
                    after: options.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.searchPublishers || {
                publishers: [],
                pageInfo: {
                    endCursor: null,
                    hasNextPage: false,
                    pageSize: options.first ?? 20,
                },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'source-service', method: 'searchPublishers' },
                extra: { options },
            });
            throw error;
        }
    }

}

export default SourceService;
