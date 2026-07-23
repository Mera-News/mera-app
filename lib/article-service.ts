import { gql } from '@apollo/client';
import client from './apollo-client';
import {
    ArticleIdsForTopicsResponse,
    ArticlesForPublicationSourceResponse,
    ArticlesForTopicsByIdsResponse,
    ArticleSummary,
    ArticleWithClusters,
    NewsArticle,
    NewsCluster,
    NewsClustersResponse,
    PersonaQueryInput,
    PersonaQueryResult,
    TopHeadlinesForCountryResponse,
    TopicPaginationInput,
} from './generated/graphql-types';
import logger from './logger';
import { isNotSubscribedError } from './subscription/not-subscribed-error';
import { navigateToPaywall } from './nav-state';

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
        geo_tags {
          city
          region
          countryCode
        }
        event_type
        entities
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

// GraphQL Query for a country's precomputed, cluster-deduplicated top
// headlines (each big story appears once), paged over the materialized
// edition. A null/"GLOBAL" countryCode spans all countries. Falls back to the
// live path (editionBuiltAt: null) when no edition exists yet. Mirrors
// GET_ARTICLES_FOR_COUNTRY's article field set inside each headline slot.
const GET_TOP_HEADLINES_FOR_COUNTRY = gql`
  query GetTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) {
    topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) {
      headlines {
        stableClusterId
        clusterSize
        article {
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
          geo_tags {
            city
            region
            countryCode
          }
          event_type
          entities
          publicationSource {
            _id
            publication_name
            country_code
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      editionBuiltAt
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
  query GetNewsClusters($countryCodes: [String!], $first: Int, $after: String) {
    newsClusters(countryCodes: $countryCodes, first: $first, after: $after) {
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

// GraphQL Query for the live cluster an article currently belongs to (via its
// newest cluster-article-link). Null when the article is unclustered or its
// cluster has aged out. The follow-a-story flow uses it to read a story's
// current member articles (to ground the LLM's scope-pill proposals). Mirrors
// GET_NEWS_CLUSTER_FOR_USER's selection, plus stableClusterId/clusterSize.
const GET_NEWS_CLUSTER_FOR_ARTICLE = gql`
  query GetNewsClusterForArticle($articleId: ID!, $first: Int, $after: String) {
    newsClusterForArticle(articleId: $articleId) {
      _id
      stableClusterId
      clusterSize
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

// (removed: trackStory / trackedStory — followed stories are now pure on-device
// topics, grown by the persona query each fetch cycle; no server archive.)

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
// The daily-delivery cap is charged here (the server's delivery point), so a
// clipped response carries `dailyLimitReached` + `resetAt`.
const GET_ARTICLES_FOR_TOPICS_BY_IDS = gql`
  query GetArticlesForTopicsByIds($articleIds: [ID!]!) {
    articlesForTopicsByIds(articleIds: $articleIds) {
      articles {
        _id
        clusters {
          clusterId
          confidence
          stableClusterId
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
        geo_tags {
          city
          region
          countryCode
        }
        entities
        event_type
        category
        maxClusterSize
      }
      dailyLimitReached
      resetAt
    }
  }
`;

// [Persona v3] Privacy-lean candidate listing: topic texts + limits +
// COUNTRY/GLOBAL headline scopes only (NO locations/weights/negatives ever leave
// the device). The server stores nothing and charges no quota here (quota is
// charged at hydration). Response carries per-topic matchMeta (vectorScore +
// stableClusterId) and separate per-scope headlineResults.
const GET_ARTICLE_IDS_FOR_PERSONA = gql`
  query GetArticleIdsForPersona($query: PersonaQueryInput!) {
    articleIdsForPersona(query: $query) {
      topicResults {
        topicText
        articleIds
        matchMeta {
          articleId
          vectorScore
          textScore
          stableClusterId
        }
        nextCursor
        hasNextPage
      }
      headlineResults {
        scope
        countryCode
        articleIds
        clusterSizes
        stableClusterIds
      }
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
    TopHeadline,
    TopHeadlinesForCountryResponse,
    TopicArticleIdsResult,
    TopicPaginationInput,
} from './generated/graphql-types';

// [Flow v2] The server rejects an articleIdsForTopics request carrying more than
// 200 topics with BAD_USER_INPUT. Users accumulate unbounded on-device topics,
// so a single feed-sync could send hundreds at once. We chunk below the server
// cap (with headroom) and run the batches SEQUENTIALLY — each cold topic costs
// the server a Jina embed + vector search, so parallel batches would spike load.
const MAX_TOPICS_PER_BATCH = 150;

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
        const limitPerTopic = opts?.limitPerTopic ?? 20;
        try {
            // Stay under the server's per-request topic cap. `limitPerTopic` is a
            // per-topic bound, so batching leaves its semantics unchanged. Batches
            // run sequentially to avoid stacking cold-topic vector searches.
            if (topics.length <= MAX_TOPICS_PER_BATCH) {
                return await this.queryArticleIdsBatch(topics, limitPerTopic);
            }

            const merged: ArticleIdsForTopicsResponse['results'] = [];
            const seenTopics = new Set<string>();
            for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_BATCH) {
                const batch = topics.slice(i, i + MAX_TOPICS_PER_BATCH);
                const { results } = await this.queryArticleIdsBatch(batch, limitPerTopic);
                // Preserve order; de-dup by topicText so a topic never appears twice.
                for (const result of results) {
                    if (seenTopics.has(result.topicText)) continue;
                    seenTopics.add(result.topicText);
                    merged.push(result);
                }
            }
            return { results: merged };
        } catch (error) {
            // The For You feed is the sole subscription gate: when the server
            // forces subscriptions, these queries 402 (PAYMENT_REQUIRED) for
            // unsubscribed users. Surface the paywall here so it's scoped to the
            // For You screen and never interrupts login/onboarding.
            if (isNotSubscribedError(error)) {
                navigateToPaywall();
                throw error;
            }
            // The apollo-error-link already captures this to Sentry; a
            // service-level captureException here would double-report (and, on a
            // retried storm, multiply). Leave a breadcrumb for context instead.
            logger.addBreadcrumb(
                '[ArticleService] getArticleIdsForTopics FAILED',
                'article-service',
                { method: 'getArticleIdsForTopics', topicCount: topics.length },
                'warning',
            );
            throw error;
        }
    }

    /**
     * [Persona v3] Fetch candidate article ids for the privacy-lean persona
     * query: topic texts + per-topic limits + COUNTRY/GLOBAL headline scopes.
     * Returns per-topic results (with matchMeta) + per-scope headline results.
     * The daily-delivery cap is NOT charged here (candidate listing is free —
     * it is charged at hydration via getArticlesForTopicsByIds).
     */
    static async getArticleIdsForPersona(
        query: PersonaQueryInput,
    ): Promise<PersonaQueryResult> {
        try {
            const { data } = await client.query<{
                articleIdsForPersona: PersonaQueryResult;
            }>({
                query: GET_ARTICLE_IDS_FOR_PERSONA,
                variables: { query },
                fetchPolicy: 'no-cache',
            });
            return (
                data?.articleIdsForPersona ?? { topicResults: [], headlineResults: [] }
            );
        } catch (error) {
            // The For You feed is the sole subscription gate — surface the paywall
            // here, scoped to For You (mirrors getArticleIdsForTopics).
            if (isNotSubscribedError(error)) {
                navigateToPaywall();
                throw error;
            }
            logger.addBreadcrumb(
                '[ArticleService] getArticleIdsForPersona FAILED',
                'article-service',
                { method: 'getArticleIdsForPersona', topicCount: query.topics.length },
                'warning',
            );
            throw error;
        }
    }

    /** Single-request articleIdsForTopics call (one batch of ≤ server cap topics). */
    private static async queryArticleIdsBatch(
        topics: TopicPaginationInput[],
        limitPerTopic: number,
    ): Promise<ArticleIdsForTopicsResponse> {
        const { data } = await client.query<{
            articleIdsForTopics: ArticleIdsForTopicsResponse;
        }>({
            query: GET_ARTICLE_IDS_FOR_TOPICS,
            variables: { topics, limitPerTopic },
            fetchPolicy: 'no-cache',
        });
        return data?.articleIdsForTopics ?? { results: [] };
    }

    /**
     * Fetch full article records for a set of IDs. Returns the hydrated
     * `articles` (with per-cluster membership
     * `clusters { clusterId confidence stableClusterId }` for the feed's collapse
     * logic) plus the daily-delivery-cap signal — the
     * cap is charged server-side at this delivery point, so `dailyLimitReached`
     * is true (with `resetAt`) when the cap clipped the response. Chunk size
     * matches the server's max-50 limit; the flags are OR'd across chunks.
     */
    static async getArticlesForTopicsByIds(
        articleIds: string[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<{ articles: ArticleWithClusters[]; dailyLimitReached: boolean; resetAt?: string }> {
        if (articleIds.length === 0) return { articles: [], dailyLimitReached: false };

        const CHUNK = 50;
        const CONCURRENCY = 5;
        const batches: string[][] = [];
        for (let i = 0; i < articleIds.length; i += CHUNK) {
            batches.push(articleIds.slice(i, i + CHUNK));
        }
        const results: ArticleWithClusters[] = [];
        let dailyLimitReached = false;
        let resetAt: string | undefined;
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
                            articlesForTopicsByIds: ArticlesForTopicsByIdsResponse;
                        }>({
                            query: GET_ARTICLES_FOR_TOPICS_BY_IDS,
                            variables: { articleIds: batch },
                            fetchPolicy: 'no-cache',
                        });
                        const rows = data?.articlesForTopicsByIds?.articles ?? [];
                        if (rows.length) results.push(...rows);
                        if (data?.articlesForTopicsByIds?.dailyLimitReached) {
                            dailyLimitReached = true;
                            resetAt = resetAt ?? data.articlesForTopicsByIds.resetAt ?? undefined;
                        }
                        completedIds += batch.length;
                        onProgress?.(completedIds, articleIds.length);
                    }
                },
            );
            await Promise.all(workers);
            return { articles: results, dailyLimitReached, resetAt };
        } catch (error) {
            // See getArticleIdsForTopics: the paywall is triggered from the feed
            // layer, scoped to For You.
            if (isNotSubscribedError(error)) {
                navigateToPaywall();
                throw error;
            }
            // apollo-error-link already captures this to Sentry — breadcrumb only
            // here to avoid double- (previously triple-) reporting.
            logger.addBreadcrumb(
                '[ArticleService] getArticlesForTopicsByIds FAILED',
                'article-service',
                { method: 'getArticlesForTopicsByIds', idCount: articleIds.length },
                'error',
            );
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
     * Get a country's precomputed, cluster-deduplicated "top headlines" with
     * pagination — each big story appears once, ranked over the materialized
     * edition. Pass 'GLOBAL' (or omit) for all countries. `editionBuiltAt` is
     * null when no edition exists yet (server fell back to the live path).
     */
    static async getTopHeadlinesForCountry(
        countryCode: string | null | undefined,
        options: { first?: number; after?: string }
    ): Promise<TopHeadlinesForCountryResponse> {
        try {
            const { data } = await client.query<{ topHeadlinesForCountry: TopHeadlinesForCountryResponse }>({
                query: GET_TOP_HEADLINES_FOR_COUNTRY,
                variables: {
                    countryCode: countryCode === 'GLOBAL' ? null : countryCode,
                    first: options?.first ?? 20,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.topHeadlinesForCountry || {
                articles: [],
                headlines: [],
                editionBuiltAt: null,
                pageInfo: { endCursor: null, hasNextPage: false, pageSize: options?.first ?? 20 },
            };
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getTopHeadlinesForCountry' },
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
     * Used by Sources L3 (with countryCodes)
     *
     * NOTE: currently has no call sites — dead code, not load-bearing.
     */
    static async getNewsClusters(
        options?: {
            countryCodes?: string[];
            first?: number;
            after?: string;
        }
    ): Promise<NewsClustersResponse> {
        try {
            const { data } = await client.query<{ newsClusters: NewsClustersResponse }>({
                query: GET_NEWS_CLUSTERS,
                variables: {
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

    /**
     * Get the live cluster an article currently belongs to (via its newest
     * cluster-article-link). Returns null when the article is unclustered or
     * its cluster has aged out. Used as the live fallback when a story isn't
     * archived (trackStory/getTrackedStory returned null).
     */
    static async getNewsClusterForArticle(
        articleId: string,
        options?: { first?: number; after?: string }
    ): Promise<NewsCluster | null> {
        try {
            const { data } = await client.query<{ newsClusterForArticle: NewsCluster | null }>({
                query: GET_NEWS_CLUSTER_FOR_ARTICLE,
                variables: {
                    articleId,
                    first: options?.first ?? 10,
                    after: options?.after,
                },
                fetchPolicy: 'no-cache',
            });

            return data?.newsClusterForArticle ?? null;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'article-service', method: 'getNewsClusterForArticle' },
                extra: { articleId },
            });
            throw error;
        }
    }

}

export default ArticleService;
