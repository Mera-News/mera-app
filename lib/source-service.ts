import { gql } from '@apollo/client';
import client from './apollo-client';
import {
    NewsPublisher,
    NewsPublishersResponse,
    PublicationSource,
    PublicationSourcesResponse,
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

export type { PublicationSource, PublicationSourcesResponse, NewsPublisher, NewsPublishersResponse };

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

}

export default SourceService;
