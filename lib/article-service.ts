import { gql } from '@apollo/client';
import client from './apollo-client';
import {
    ArticleIdsForTopicsResponse,
    ArticlesForPublicationSourceResponse,
    ArticleSummary,
    ArticleWithClusters,
    NewsArticle,
    NewsCluster,
    NewsClustersResponse,
    TopicPaginationInput,
} from './generated/graphql-types';
import logger from './logger';

// GraphQL Query for fetching articles for a cluster (excluding already shown articles)
const GET_ARTICLES_FOR_CLUSTER = gql`
  query GetArticlesForCluster($clusterId: ID!, $articleIdsToExclude: [ID!]) {
    articlesForCluster(clusterId: $clusterId, articleIdsToExclude: $articleIdsToExclude) {
      _id
      title
      title_en_internal_only
      description
      description_en_internal_only
      original_language_code
      pubDate
      article_url
      image_url
      creator
      source_uri
      clusterConfidence
      publicationSource {
        _id
        publication_name
      }
    }
  }
`;

// GraphQL Query for fetching a single article by ID.
const GET_ARTICLE_BY_ID = gql`
  query GetArticleById($id: ID!) {
    articleById(id: $id) {
      _id
      title
      title_en_internal_only
      description
      description_en_internal_only
      pubDate
      article_url
      image_url
      creator
      source_uri
      original_language_code
      publicationSource {
        _id
        publication_name
        publication_url
        country_code
        country_name
        category
        detected_language_code
        feed_language_code
      }
    }
  }
`;

// GraphQL Query for fetching articles for a publication source
const GET_ARTICLES_FOR_PUBLICATION_SOURCE = gql`
  query GetArticlesForPublicationSource($publicationSourceId: ID!, $first: Int, $after: String) {
    articlesForPublicationSource(publicationSourceId: $publicationSourceId, first: $first, after: $after) {
      articles {
        _id
        title
        title_en_internal_only
        description
        description_en_internal_only
        pubDate
        article_url
        image_url
        creator
        source_uri
        original_language_code
        publicationSource {
          _id
          publication_name
          country_code
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

// GraphQL Query for a country's "top headlines": last-24h articles across all
// the country's sources, sorted by largest cluster size (server-side global
// sort). A null/"GLOBAL" countryCode spans all countries.
const GET_ARTICLES_FOR_COUNTRY = gql`
  query GetArticlesForCountry($countryCode: String, $first: Int, $after: String) {
    articlesForCountry(countryCode: $countryCode, first: $first, after: $after) {
      articles {
        _id
        title
        title_en_internal_only
        description
        description_en_internal_only
        pubDate
        article_url
        image_url
        creator
        source_uri
        original_language_code
        publicationSource {
          _id
          publication_name
          country_code
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

// GraphQL Query for a publisher's "top headlines": last-24h articles
// aggregated across all the publisher's feeds, sorted by largest cluster size.
const GET_ARTICLES_FOR_PUBLISHER = gql`
  query GetArticlesForPublisher($newsPublisherId: ID!, $first: Int, $after: String) {
    articlesForPublisher(newsPublisherId: $newsPublisherId, first: $first, after: $after) {
      articles {
        _id
        title
        title_en_internal_only
        description
        description_en_internal_only
        pubDate
        article_url
        image_url
        creator
        source_uri
        original_language_code
        publicationSource {
          _id
          publication_name
          country_code
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

// GraphQL Query for fetching news clusters (paginated, unordered)
const GET_NEWS_CLUSTERS = gql`
  query GetNewsClusters($userTopicId: ID, $countryCodes: [String!], $first: Int, $after: String) {
    newsClusters(userTopicId: $userTopicId, countryCodes: $countryCodes, first: $first, after: $after) {
      newsClusters {
        _id
        createdAt
        updatedAt
        topicConfidence
        articles(first: 1) {
          articles {
            _id
            image_url
            title
            title_en_internal_only
            original_language_code
            pubDate
            publicationSource {
              _id
              publication_name
              country_code
            }
          }
          pageInfo {
            endCursor
            hasNextPage
            pageSize
          }
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

// GraphQL Query for fetching clusters by topic text string (no server topic ID needed)
const GET_NEWS_CLUSTERS_FOR_TOPIC_TEXT = gql`
  query GetNewsClustersForTopicText($topicText: String!, $first: Int, $after: String) {
    newsClustersForTopicText(topicText: $topicText, first: $first, after: $after) {
      newsClusters {
        _id
        createdAt
        updatedAt
        topicConfidence
        articles(first: 1) {
          articles {
            _id
            image_url
            title
            title_en_internal_only
            original_language_code
            pubDate
            publicationSource {
              _id
              publication_name
              country_code
            }
          }
          pageInfo {
            endCursor
            hasNextPage
            pageSize
          }
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

// GraphQL Query for fetching a single news cluster with articles.
// `articles` is a cursor-paginated connection; server caps each page at 10.
const GET_NEWS_CLUSTER_FOR_USER = gql`
  query GetNewsClusterForUser($clusterId: ID!, $first: Int, $after: String) {
    newsClusterForUser(clusterId: $clusterId) {
      _id
      createdAt
      updatedAt
      articles(first: $first, after: $after) {
        articles {
          _id
          title
          title_en_internal_only
          description
          description_en_internal_only
          pubDate
          article_url
          image_url
          creator
          source_uri
          original_language_code
          clusterConfidence
          publicationSource {
            _id
            publication_name
            publication_url
            country_code
            country_name
            category
            detected_language_code
            feed_language_code
          }
        }
        pageInfo {
          endCursor
          hasNextPage
          pageSize
        }
      }
    }
  }
`;

// (removed: GET_SERVER_PROCESSING_METADATA_FOR_USER — serverProcessingMetadataForUser no longer exists)

// Placeholder to keep line reference intact

// GraphQL Query fetching the live sibling articles for a given article. Used
// by the detail screen's "Related articles" section. Returns every sibling in
// one shot; pagination can be added later if needed.
const GET_RELATED_ARTICLES = gql`
  query GetRelatedArticles($articleId: ID!) {
    relatedArticles(articleId: $articleId) {
      _id
      title_en
      description_en
      article_url
      image_url
      country_code
      publication_name
      language_code
      pubDate
    }
  }
`;

const GET_RECENT_ARTICLE_COUNT = gql`
  query GetRecentArticleCount {
    recentArticleCount
  }
`;

// [Flow v2] GraphQL Query: per-topic article IDs with cursor-based pagination.
// The server checks Redis (30 min TTL) first; on miss it runs a vector search
// with a hardcoded 24h cutoff. The app diffs the returned IDs against its
// local DB and only fetches missing full records via articlesForTopicsByIds.
const GET_ARTICLE_IDS_FOR_TOPICS = gql`
  query GetArticleIdsForTopics($topics: [TopicPaginationInput!]!, $limitPerTopic: Int) {
    articleIdsForTopics(topics: $topics, limitPerTopic: $limitPerTopic) {
      results {
        topicText
        articleIds
        hasNextPage
        nextCursor
      }
    }
  }
`;

// [Flow v2] GraphQL Query: hydrate full article records for IDs the app
// doesn't already have locally. Returns ArticleWithClusters which includes
// per-cluster membership confidence for the For-You feed's collapse logic.
const GET_ARTICLES_FOR_TOPICS_BY_IDS = gql`
  query GetArticlesForTopicsByIds($articleIds: [ID!]!) {
    articlesForTopicsByIds(articleIds: $articleIds) {
      _id
      clusters {
        clusterId
        confidence
      }
      title_en
      title
      description_en
      article_url
      image_url
      country_code
      publication_name
      language_code
      pubDate
    }
  }
`;

// Use generated GraphQL types
export type {
    ArticleIdsForTopicsResponse,
    ArticleSummary,
    ArticleWithClusters,
    NewsArticle,
    NewsCluster,
    NewsClustersResponse,
    TopicArticleIdsResult,
    TopicPaginationInput,
} from './generated/graphql-types';

// Article Service Class
export class ArticleService {
    /**
     * Get the floor of the hour (00 minutes, 00 seconds, 00 milliseconds)
     * This helps with caching on the backend by ensuring consistent fromDate values within an hour
     */
    static getFloorOfHour(date: Date = new Date()): Date {
        const flooredDate = new Date(date);
        flooredDate.setMinutes(0, 0, 0);
        return flooredDate;
    }

    /**
     * Get a date from N hours ago, floored to the hour
     * Example: getFlooredDateHoursAgo(24) returns ISO string of 24 hours ago with 00:00:00.000 time
     */
    static getFlooredDateHoursAgo(hoursAgo: number): string {
        const date = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
        return this.getFloorOfHour(date).toISOString();
    }

    static async getRecentArticleCount(): Promise<number> {
        try {
            const { data } = await client.query<{ recentArticleCount: number }>({
                query: GET_RECENT_ARTICLE_COUNT,
                fetchPolicy: 'no-cache',
            });
            return data?.recentArticleCount ?? 0;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getRecentArticleCount' },
            });
            return 0;
        }
    }

    /**
     * [Flow v2] Fetch the set of article IDs matching each topic text.
     * Server checks a 30-min Redis cache first; on miss it runs vector search
     * against the last 24 hours of articles. Each topic result carries its own
     * cursor so the caller can request additional pages per topic independently.
     */
    static async getArticleIdsForTopics(
        topics: TopicPaginationInput[],
        opts?: { limitPerTopic?: number },
    ): Promise<ArticleIdsForTopicsResponse> {
        try {
            const { data } = await client.query<{
                articleIdsForTopics: ArticleIdsForTopicsResponse;
            }>({
                query: GET_ARTICLE_IDS_FOR_TOPICS,
                variables: { topics, limitPerTopic: opts?.limitPerTopic ?? 20 },
                fetchPolicy: 'no-cache',
            });
            return data?.articleIdsForTopics ?? { results: [] };
        } catch (error) {
            logger.warn('[ArticleService] getArticleIdsForTopics FAILED', { topicCount: topics.length });
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticleIdsForTopics' },
                extra: { topicCount: topics.length },
            });
            throw error;
        }
    }

    /**
     * Fetch full article records for a set of IDs. Returns `ArticleWithClusters`
     * which includes per-cluster membership `clusters { clusterId confidence }`
     * for the feed's collapse logic. Chunk size matches the server's max-50 limit.
     */
    static async getArticlesForTopicsByIds(
        articleIds: string[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<ArticleWithClusters[]> {
        if (articleIds.length === 0) return [];

        const CHUNK = 50;
        const CONCURRENCY = 5;
        const batches: string[][] = [];
        for (let i = 0; i < articleIds.length; i += CHUNK) {
            batches.push(articleIds.slice(i, i + CHUNK));
        }
        const results: ArticleWithClusters[] = [];
        let completedIds = 0;
        onProgress?.(0, articleIds.length);

        try {
            let nextIndex = 0;
            const workers = Array.from(
                { length: Math.min(CONCURRENCY, batches.length) },
                async () => {
                    while (true) {
                        const idx = nextIndex++;
                        if (idx >= batches.length) return;
                        const batch = batches[idx];
                        const { data } = await client.query<{
                            articlesForTopicsByIds: ArticleWithClusters[];
                        }>({
                            query: GET_ARTICLES_FOR_TOPICS_BY_IDS,
                            variables: { articleIds: batch },
                            fetchPolicy: 'no-cache',
                        });
                        const rows = data?.articlesForTopicsByIds ?? [];
                        if (rows.length) results.push(...rows);
                        completedIds += batch.length;
                        onProgress?.(completedIds, articleIds.length);
                    }
                },
            );
            await Promise.all(workers);
            return results;
        } catch (error) {
            logger.error('[ArticleService] getArticlesForTopicsByIds FAILED', error);
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticlesForTopicsByIds' },
                extra: { idCount: articleIds.length },
            });
            throw error;
        }
    }

    /**
     * Fetch live sibling articles for a given article via the server's
     * cluster-article-link snapshot. Used by the detail screen's "Related
     * articles" section. Returns the empty list if the article has no live
     * cluster (e.g. cluster TTL'd out).
     */
    static async getRelatedArticles(articleId: string): Promise<ArticleSummary[]> {
        try {
            const { data } = await client.query<{ relatedArticles: ArticleSummary[] }>({
                query: GET_RELATED_ARTICLES,
                variables: { articleId },
                fetchPolicy: 'no-cache',
            });
            return data?.relatedArticles ?? [];
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getRelatedArticles' },
                extra: { articleId },
            });
            throw error;
        }
    }

    /**
     * Fetch a single article by ID. Returns null if the server has TTL'd it
     * out or the ID is unknown — the caller treats that as the not-found
     * state.
     */
    static async getArticleById(articleId: string): Promise<NewsArticle | null> {
        try {
            const { data } = await client.query<{ articleById: NewsArticle | null }>({
                query: GET_ARTICLE_BY_ID,
                variables: { id: articleId },
                fetchPolicy: 'no-cache',
            });
            return data?.articleById ?? null;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticleById' },
                extra: { articleId },
            });
            throw error;
        }
    }

    /**
     * Get articles for a cluster, optionally excluding specific article IDs
     */
    static async getArticlesForCluster(
        clusterId: string,
        articleIdsToExclude?: string[]
    ): Promise<NewsArticle[]> {
        try {
            const { data } = await client.query<{ articlesForCluster: NewsArticle[] }>({
                query: GET_ARTICLES_FOR_CLUSTER,
                variables: {
                    clusterId,
                    articleIdsToExclude,
                },
                fetchPolicy: 'cache-first',
            });

            return data?.articlesForCluster || [];
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticlesForCluster' },
                extra: { clusterId, articleIdsToExclude },
            });
            throw error;
        }
    }

    /**
     * Get articles for a publication source with pagination
     */
    static async getArticlesForPublicationSource(
        publicationSourceId: string,
        options?: { first?: number; after?: string }
    ): Promise<ArticlesForPublicationSourceResponse> {
        try {
            const { data } = await client.query<{ articlesForPublicationSource: ArticlesForPublicationSourceResponse }>({
                query: GET_ARTICLES_FOR_PUBLICATION_SOURCE,
                variables: {
                    publicationSourceId,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.articlesForPublicationSource || {
                articles: [],
                pageInfo: { endCursor: null, hasNextPage: false, pageSize: options?.first ?? 20 },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticlesForPublicationSource' },
                extra: { publicationSourceId },
            });
            throw error;
        }
    }

    /**
     * Get a country's "top headlines" with pagination — last-24h articles
     * across all the country's sources, sorted by largest cluster size on the
     * server. Pass 'GLOBAL' (or omit) for all countries.
     */
    static async getArticlesForCountry(
        countryCode: string | undefined,
        options?: { first?: number; after?: string }
    ): Promise<ArticlesForPublicationSourceResponse> {
        try {
            const { data } = await client.query<{ articlesForCountry: ArticlesForPublicationSourceResponse }>({
                query: GET_ARTICLES_FOR_COUNTRY,
                variables: {
                    countryCode: countryCode === 'GLOBAL' ? null : countryCode,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.articlesForCountry || {
                articles: [],
                pageInfo: { endCursor: null, hasNextPage: false, pageSize: options?.first ?? 20 },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticlesForCountry' },
                extra: { countryCode },
            });
            throw error;
        }
    }

    /**
     * Get a publisher's "top headlines" with pagination — last-24h articles
     * aggregated across all the publisher's feeds, sorted by largest cluster
     * size on the server.
     */
    static async getArticlesForPublisher(
        newsPublisherId: string,
        options?: { first?: number; after?: string }
    ): Promise<ArticlesForPublicationSourceResponse> {
        try {
            const { data } = await client.query<{ articlesForPublisher: ArticlesForPublicationSourceResponse }>({
                query: GET_ARTICLES_FOR_PUBLISHER,
                variables: {
                    newsPublisherId,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.articlesForPublisher || {
                articles: [],
                pageInfo: { endCursor: null, hasNextPage: false, pageSize: options?.first ?? 20 },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticlesForPublisher' },
                extra: { newsPublisherId },
            });
            throw error;
        }
    }

    /**
     * Get news clusters (paginated, server returns them unordered)
     * Used by Persona L3 (with userTopicId) and Sources L3 (with countryCodes)
     */
    static async getNewsClusters(
        options?: {
            userTopicId?: string;
            countryCodes?: string[];
            first?: number;
            after?: string;
        }
    ): Promise<NewsClustersResponse> {
        try {
            const { data } = await client.query<{ newsClusters: NewsClustersResponse }>({
                query: GET_NEWS_CLUSTERS,
                variables: {
                    userTopicId: options?.userTopicId,
                    countryCodes: options?.countryCodes,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.newsClusters || {
                newsClusters: [],
                pageInfo: {
                    endCursor: null,
                    hasNextPage: false,
                    pageSize: options?.first ?? 20,
                },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getNewsClusters' },
                extra: { options },
            });
            throw error;
        }
    }

    /**
     * Get news clusters by topic text string (no server topic ID required).
     * Used by PersonaArticleList after the server topic sync pipeline was removed.
     */
    static async getNewsClustersForTopicText(
        topicText: string,
        options?: { first?: number; after?: string }
    ): Promise<NewsClustersResponse> {
        try {
            const { data } = await client.query<{ newsClustersForTopicText: NewsClustersResponse }>({
                query: GET_NEWS_CLUSTERS_FOR_TOPIC_TEXT,
                variables: {
                    topicText,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.newsClustersForTopicText || {
                newsClusters: [],
                pageInfo: {
                    endCursor: null,
                    hasNextPage: false,
                    pageSize: options?.first ?? 20,
                },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getNewsClustersForTopicText' },
                extra: { topicText },
            });
            throw error;
        }
    }

    /**
     * Get a single news cluster with resolved articles
     * Used by the NewsClusterScreen
     */
    static async getNewsClusterForUser(
        clusterId: string,
        options?: { first?: number; after?: string }
    ): Promise<NewsCluster> {
        try {
            const { data } = await client.query<{ newsClusterForUser: NewsCluster }>({
                query: GET_NEWS_CLUSTER_FOR_USER,
                variables: {
                    clusterId,
                    first: options?.first ?? 10,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            if (!data?.newsClusterForUser) {
                throw new Error('News cluster not found');
            }

            return data.newsClusterForUser;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getNewsClusterForUser' },
                extra: { clusterId },
            });
            throw error;
        }
    }

}

export default ArticleService;
