import { gql } from '@apollo/client';
import client from './apollo-client';
import {
    ArticleIdsForTopicsResponse,
    ArticlesForPublicationSourceResponse,
    ArticleSuggestionWithMetadata,
    ArticleSummary,
    ArticleWithClusters,
    NewsArticle,
    NewsCluster,
    NewsClustersResponse,
    RefreshSuggestionsResponse,
    ServerProcessingMetadataForUserResponse,
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

// GraphQL Query returning system-wide + per-user processing metadata.
const GET_SERVER_PROCESSING_METADATA_FOR_USER = gql`
  query GetServerProcessingMetadataForUser($userPersonaId: ID!) {
    serverProcessingMetadataForUser(userPersonaId: $userPersonaId) {
      totalArticlesToday
      articleSuggestionCountForUser
    }
  }
`;

// GraphQL Query returning just the set of unscored ArticleSuggestion IDs the
// server currently has for the persona (24h window). The client diffs this
// against its local DB and only fetches missing full records via the by-ids
// query.
const GET_UNSCORED_ARTICLE_SUGGESTION_IDS = gql`
  query GetUnscoredArticleSuggestionIds($userPersonaId: ID!) {
    unscoredArticleSuggestionIds(userPersonaId: $userPersonaId)
  }
`;

// GraphQL Query fetching full ArticleSuggestion records by ID, in batches.
const GET_UNSCORED_ARTICLE_SUGGESTIONS_BY_IDS = gql`
  query GetUnscoredArticleSuggestionByIds($userPersonaId: ID!, $ids: [ID!]!) {
    unscoredArticleSuggestionByIds(userPersonaId: $userPersonaId, ids: $ids) {
      _id
      articleId
      clusterIds
      title_en
      description_en
      article_url
      image_url
      country_code
      publication_name
      language_code
      firstPubDate
      userTopicIds
      createdAt
    }
  }
`;

// Persona's other ArticleSuggestions sharing `clusterId`, excluding the
// article currently being viewed. Drives the sibling-suggestions section
// on the detail screen.
const GET_SIBLING_ARTICLE_SUGGESTIONS = gql`
  query GetSiblingArticleSuggestions(
    $userPersonaId: ID!
    $clusterId: ID!
    $excludeArticleId: ID
  ) {
    siblingArticleSuggestions(
      userPersonaId: $userPersonaId
      clusterId: $clusterId
      excludeArticleId: $excludeArticleId
    ) {
      _id
      articleId
      clusterIds
      title_en
      description_en
      article_url
      image_url
      country_code
      publication_name
      language_code
      firstPubDate
      userTopicIds
      createdAt
    }
  }
`;

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
// clusterIds for the For-You feed's stacking logic.
const GET_ARTICLES_FOR_TOPICS_BY_IDS = gql`
  query GetArticlesForTopicsByIds($articleIds: [ID!]!) {
    articlesForTopicsByIds(articleIds: $articleIds) {
      _id
      clusterIds
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

// GraphQL Mutation for refreshing suggestions for a user
const CREATE_SUGGESTIONS_FOR_USER = gql`
  mutation RefreshSuggestionsForUser($userId: ID!) {
    refreshSuggestionsForUser(userId: $userId) {
      success
      message
    }
  }
`;

// Use generated GraphQL types
export type {
    ArticleIdsForTopicsResponse,
    ArticleSuggestionWithMetadata,
    ArticleSummary,
    ArticleWithClusters,
    CursorPageInfo,
    NewsArticle,
    NewsCluster,
    NewsClustersResponse,
    ServerProcessingMetadataForUserResponse,
    TopicArticleIdsResult,
    TopicPaginationInput,
} from './generated/graphql-types';

export interface CreateSuggestionsResponse {
    refreshSuggestionsForUser: RefreshSuggestionsResponse;
}

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

    /**
     * Fetch the set of unscored ArticleSuggestion IDs currently held by the
     * server for the calling user (24h window). The caller diffs these IDs
     * against the local WatermelonDB to decide what to fetch.
     */
    static async getUnscoredArticleSuggestionIds(userPersonaId: string): Promise<string[]> {
        try {
            const { data } = await client.query<{
                unscoredArticleSuggestionIds: string[];
            }>({
                query: GET_UNSCORED_ARTICLE_SUGGESTION_IDS,
                variables: { userPersonaId },
                fetchPolicy: 'no-cache',
            });

            return data?.unscoredArticleSuggestionIds ?? [];
        } catch (error) {
            logger.error('[ArticleService] getUnscoredArticleSuggestionIds FAILED', error);
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getUnscoredArticleSuggestionIds' },
            });
            throw error;
        }
    }

    /**
     * Fetch system-wide and per-user processing metadata. The
     * `totalArticlesToday` field is cached on the server for 30 min;
     * `articleSuggestionCountForUser` is always fresh.
     */
    static async getServerProcessingMetadataForUser(
        userPersonaId: string
    ): Promise<ServerProcessingMetadataForUserResponse> {
        try {
            const { data } = await client.query<{
                serverProcessingMetadataForUser: ServerProcessingMetadataForUserResponse;
            }>({
                query: GET_SERVER_PROCESSING_METADATA_FOR_USER,
                variables: { userPersonaId },
                fetchPolicy: 'no-cache',
            });

            return (
                data?.serverProcessingMetadataForUser ?? {
                    totalArticlesToday: 0,
                    articleSuggestionCountForUser: 0,
                }
            );
        } catch (error) {
            logger.error('[ArticleService] getServerProcessingMetadataForUser FAILED', error);
            throw error;
        }
    }

    /**
     * Fetch full ArticleSuggestion records by ID, chunked to respect the
     * server's MAX_IDS_PER_REQUEST limit.
     */
    static async getUnscoredArticleSuggestionsByIds(
        userPersonaId: string,
        ids: string[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<ArticleSuggestionWithMetadata[]> {
        if (ids.length === 0) return [];

        const CHUNK = 50;
        const CONCURRENCY = 5;
        const batches: string[][] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            batches.push(ids.slice(i, i + CHUNK));
        }
        const results: ArticleSuggestionWithMetadata[] = [];
        let completed = 0;
        let completedIds = 0;
        const startedAt = Date.now();
        if (__DEV__) {
            console.log(
                `[ArticleService] hydrating ${ids.length} ids in ${batches.length} chunks ` +
                `(chunk=${CHUNK}, concurrency=${CONCURRENCY})`,
            );
        }
        onProgress?.(0, ids.length);

        try {
            let nextIndex = 0;
            const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
                while (true) {
                    const idx = nextIndex++;
                    if (idx >= batches.length) return;
                    const batch = batches[idx];
                    const t0 = Date.now();
                    const { data } = await client.query<{
                        unscoredArticleSuggestionByIds: ArticleSuggestionWithMetadata[];
                    }>({
                        query: GET_UNSCORED_ARTICLE_SUGGESTIONS_BY_IDS,
                        variables: { userPersonaId, ids: batch },
                        fetchPolicy: 'no-cache',
                    });
                    const rows = data?.unscoredArticleSuggestionByIds ?? [];
                    const got = rows.length;
                    if (got) results.push(...rows);
                    completed++;
                    completedIds += batch.length;
                    onProgress?.(completedIds, ids.length);
                    if (__DEV__) {
                        console.log(
                            `[ArticleService] chunk ${idx + 1}/${batches.length} ` +
                            `got=${got} in ${Date.now() - t0}ms (completed=${completed}/${batches.length})`,
                        );
                    }
                }
            });
            await Promise.all(workers);
            if (__DEV__) {
                console.log(
                    `[ArticleService] hydrated ${results.length} records in ${Date.now() - startedAt}ms`,
                );
            }
            return results;
        } catch (error) {
            logger.error('[ArticleService] getUnscoredArticleSuggestionsByIds FAILED', error);
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getUnscoredArticleSuggestionsByIds' },
                extra: { idCount: ids.length },
            });
            throw error;
        }
    }

    // ─── Flow v2 ─────────────────────────────────────────────────────────────

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
            logger.error('[ArticleService] getArticleIdsForTopics FAILED', error);
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getArticleIdsForTopics' },
                extra: { topicCount: topics.length },
            });
            throw error;
        }
    }

    /**
     * [Flow v2] Fetch full article records for a set of IDs. Mirrors the
     * existing `getUnscoredArticleSuggestionsByIds` hydration pattern but
     * returns `ArticleWithClusters` which includes `clusterIds` for feed
     * stacking. Chunk size matches the server's max-50 limit.
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

    // ─── End Flow v2 ─────────────────────────────────────────────────────────

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
     * Fetch the persona's other ArticleSuggestions sharing `clusterId`,
     * excluding the article currently being viewed. Used by the detail
     * screen to render the user's other personalized cards for the same
     * story underneath the primary card.
     */
    static async getSiblingArticleSuggestions(
        userPersonaId: string,
        clusterId: string,
        excludeArticleId?: string | null,
    ): Promise<ArticleSuggestionWithMetadata[]> {
        try {
            const { data } = await client.query<{
                siblingArticleSuggestions: ArticleSuggestionWithMetadata[];
            }>({
                query: GET_SIBLING_ARTICLE_SUGGESTIONS,
                variables: { userPersonaId, clusterId, excludeArticleId: excludeArticleId ?? null },
                fetchPolicy: 'no-cache',
            });
            return data?.siblingArticleSuggestions ?? [];
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getSiblingArticleSuggestions' },
                extra: { userPersonaId, clusterId, excludeArticleId },
            });
            throw error;
        }
    }

    /**
     * Trigger creation of new suggestions for a user
     */
    static async createSuggestionsForUser(userId: string): Promise<{ success: boolean; message: string }> {
        try {
            const { data } = await client.mutate<CreateSuggestionsResponse>({
                mutation: CREATE_SUGGESTIONS_FOR_USER,
                variables: { userId },
            });

            const result = data?.refreshSuggestionsForUser || { success: false, message: 'Unknown error' };

            return result;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'createSuggestionsForUser' },
                extra: { userId },
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
