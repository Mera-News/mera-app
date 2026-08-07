import { gql } from '@apollo/client';
import client from './apollo-client';
import {
    NewsPublisher,
    NewsPublishersResponse,
    PublicationSource,
    PublicationSourcesResponse,
    PublisherSearchHit,
    SearchPublishersResponse,
} from './generated/graphql-types';
import logger from './logger';

const GET_PUBLICATION_SOURCES = gql`
  query GetPublicationSources(
    $languageCode: String
    $countryCode: String
    $category: String
    $first: Int
    $after: String
  ) {
    publicationSources(
      languageCode: $languageCode
      countryCode: $countryCode
      category: $category
      first: $first
      after: $after
    ) {
      publicationSources {
        _id
        publication_name
        publication_url
        feed_url
        type
        feed_language_code
        detected_language_code
        country_code
        country_name
        category
        publication_type
        categories
        createdAt
        updatedAt
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
    }
  }
`;

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
        publicationSources {
          _id
          feed_url
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
        matchingSources {
          _id
          publication_name
          feed_url
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
    PublicationSourcesResponse,
    NewsPublisher,
    NewsPublishersResponse,
    PublisherSearchHit,
    SearchPublishersResponse,
};

export class SourceService {
    static async getPublicationSources(options?: {
        countryCode?: string;
        languageCode?: string;
        category?: string;
        first?: number;
        after?: string;
    }): Promise<PublicationSourcesResponse> {
        try {
            const { data } = await client.query<{ publicationSources: PublicationSourcesResponse }>({
                query: GET_PUBLICATION_SOURCES,
                variables: {
                    countryCode: options?.countryCode,
                    languageCode: options?.languageCode,
                    category: options?.category,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.publicationSources || {
                publicationSources: [],
                pageInfo: {
                    endCursor: null,
                    hasNextPage: false,
                    pageSize: options?.first ?? 20,
                },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'source-service', method: 'getPublicationSources' },
                extra: { options },
            });
            throw error;
        }
    }

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
     * Publisher/website + matching-feed search (Item 8, Sources L1). The
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
