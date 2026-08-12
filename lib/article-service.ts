import { gql } from '@apollo/client';
import client from './apollo-client';
import { recordAuthFailure } from './auth-failure-breaker';
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
// The field list is shared with `factCheck(articleId)` rather than restated:
// the panel reads one shape, so a field added for one path must reach both.
import { FACT_CHECK_FIELDS } from './fact-check/fact-check-fields';
import { isUnauthenticatedError } from './utils/retry';
import { isNotSubscribedError } from './subscription/not-subscribed-error';
import { recordAiLocked } from './subscription/ai-lock';

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
  query GetArticleById($id: ID!, $withFactCheck: Boolean!) {
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
      # The ARTICLE's own classification — needed by the detail screen's
      # feedback surface, which has no local article_suggestions row to derive
      # from for a standalone article (Explore / tracked story / shared link).
      # NOT interchangeable with publicationSource.category below: that one is
      # the PUBLICATION's category.
      category
      entities
      event_type
      geo_tags {
        city
        region
        countryCode
      }
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
      # The CACHED fact check, if anybody has ever asked for one on this
      # article. Read-only on the server (it never creates a row and never
      # starts a job — see the ResolveField's own comment), so selecting it
      # here costs nothing and starts nothing.
      #
      # WHY IT RIDES ON THIS QUERY. Checks are cached server-side and keyed on
      # the article, deliberately holding no user identity — so the cache was
      # always cross-user, but only the device that ASKED ever had a local row
      # to render from. This query already runs on every article-detail open
      # through this route, so the server already receives this article id on
      # those opens: piggybacking adds no request and no new signal about what
      # anyone reads. A separate per-open lookup would have added exactly that
      # signal.
      #
      # RELEASE GATE, the same one FACT_CHECK_FIELDS carries: GraphQL fails
      # WHOLE-OPERATION validation on an unknown field, so a build shipped
      # ahead of the server change would break articleById outright, not just
      # this one field. The server ships first, by design.
      #
      # @include, NOT a client-side discard. "Auto community fact check" is OFF
      # by default, and with it off the reader has not opted into a lookup on
      # every article they open. Fetching the field and then ignoring it would
      # still have performed that lookup server-side — the switch would look
      # like a preference while being decoration. Skipping it in the DOCUMENT
      # means the resolver never runs.
      factCheck @include(if: $withFactCheck) {
        ${FACT_CHECK_FIELDS}
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

// GraphQL Query for the live cluster an article currently belongs to (via its
// newest cluster-article-link). Null when the article is unclustered or its
// cluster has aged out. The follow-a-story flow uses it to read a story's
// current member articles (to ground the LLM's scope-pill proposals). Selects
// the full article shape, plus stableClusterId/clusterSize.
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
  query GetRelatedArticles($articleId: ID!, $stableClusterId: String) {
    relatedArticles(articleId: $articleId, stableClusterId: $stableClusterId) {
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

// [r12] Quota-EXEMPT sibling of GET_ARTICLES_FOR_TOPICS_BY_IDS, for articles
// that reached the device ONLY because the user follows a story. Identical
// selection set minus the cap fields: this query is never charged against the
// daily article limit, so `dailyLimitReached` is always false and `resetAt`
// always absent — selecting them would be dead weight on every request.
const GET_ARTICLES_FOR_STORIES = gql`
  query GetArticlesForStories($articleIds: [ID!]!) {
    articlesForStories(articleIds: $articleIds) {
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

// `isUnauthenticatedError` used to be defined here. It now lives in
// `lib/utils/retry.ts` so the scheduler runner can apply the SAME 401 rule
// without importing this module (and with it the Apollo client). Behaviour is
// unchanged; see the docstring there for why there is exactly one copy.

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
     * One error-reporting policy for every read query below. Extracted because
     * the 401 rule has to be identical at a dozen catch sites — copies of it
     * would drift, and a single drifting copy is enough to re-open the storm.
     *
     * A 401 / UNAUTHENTICATED is NOT a per-request Sentry event. One dead
     * session makes every query in the app fail the same way, so capturing each
     * one buys hundreds of duplicate events for a single root cause (this is
     * MERA-APP-3P/49/5P: 324 events from one user). Leave a breadcrumb and let
     * the auth breaker's single trip event be the signal — the same policy the
     * Apollo error link applies (see lib/apollo-client.ts).
     *
     * recordAuthFailure() is called here as well as in the error link. That
     * double-counts a failure the link already saw, which only makes the
     * breaker trip a request earlier — harmless now that tripping repairs
     * before it pauses anything — and it keeps the policy correct for any
     * rejection that never passes through the link.
     *
     * Non-401 errors keep the unconditional capture they always had.
     */
    private static reportQueryError(
        method: string,
        error: unknown,
        extra?: Record<string, unknown>,
    ): void {
        if (isUnauthenticatedError(error)) {
            logger.addBreadcrumb(
                `[ArticleService] ${method} UNAUTHENTICATED`,
                'article-service',
                { method, ...extra },
                'warning',
            );
            recordAuthFailure();
            return;
        }

        logger.captureException(error, {
            tags: { service: 'article-service', method },
            ...(extra ? { extra } : {}),
        });
    }

    static async getRecentArticleCount(): Promise<number> {
        try {
            const { data } = await client.query<{ recentArticleCount: number }>({
                query: GET_RECENT_ARTICLE_COUNT,
                fetchPolicy: 'no-cache',
            });
            return data?.recentArticleCount ?? 0;
        } catch (error) {
            this.reportQueryError('getRecentArticleCount', error);
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
            // When the server forces subscriptions these queries 402
            // (PAYMENT_REQUIRED). This no longer yanks the user to the paywall:
            // Mera News Free is a legitimate place to be, and a redirect out of
            // whatever they were reading would take away exactly what this mode
            // promises to keep. Record the verdict; the surfaces react to it.
            if (isNotSubscribedError(error)) {
                recordAiLocked('topics');
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
            // Same server cap as articleIdsForTopics (MAX_TOPICS_PER_REQUEST,
            // default 200 and env-overridable). buildRetrievalProfile slices to
            // 200 today, so nothing exceeds it — but that is zero headroom, and
            // "219 exceeds the maximum of 200" was a 2209-event Sentry issue
            // before the slice landed. Batch here so a lower server cap, or a
            // caller that forgets to slice, degrades instead of failing.
            if (query.topics.length <= MAX_TOPICS_PER_BATCH) {
                return await this.queryPersonaBatch(query);
            }

            const topicResults: PersonaQueryResult['topicResults'] = [];
            const headlineResults: PersonaQueryResult['headlineResults'] = [];
            const seenTopics = new Set<string>();

            for (let i = 0; i < query.topics.length; i += MAX_TOPICS_PER_BATCH) {
                const batch: PersonaQueryInput = {
                    ...query,
                    topics: query.topics.slice(i, i + MAX_TOPICS_PER_BATCH),
                    // Headline scopes are query-level, not per-topic: repeating
                    // them on every chunk would re-run the same scope lookup and
                    // multiply headlineResults. First chunk only.
                    topHeadlines: i === 0 ? query.topHeadlines : undefined,
                };
                // Sequential, matching the topics path — each cold topic costs
                // the server a Jina embed + vector search.
                const result = await this.queryPersonaBatch(batch);
                // Preserve order; de-dup by topicText so a topic never appears twice.
                for (const topicResult of result.topicResults) {
                    if (seenTopics.has(topicResult.topicText)) continue;
                    seenTopics.add(topicResult.topicText);
                    topicResults.push(topicResult);
                }
                headlineResults.push(...result.headlineResults);
            }

            return { topicResults, headlineResults };
        } catch (error) {
            // Same verdict, different query — see getArticleIdsForTopics. One
            // shared flag, because SubscriptionGuard refused both for one reason.
            if (isNotSubscribedError(error)) {
                recordAiLocked('persona');
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

    /**
     * Single-request articleIdsForPersona call (one batch of ≤ server cap topics).
     *
     * NOTE: `query.maxArticles` is a cap on the TOTAL ids across topicResults,
     * so a chunked call applies it once per chunk. No caller sets it today
     * (feed-sync-steps builds the query without it), so splitting it across
     * chunks would be speculative machinery — revisit if one ever does.
     */
    private static async queryPersonaBatch(
        query: PersonaQueryInput,
    ): Promise<PersonaQueryResult> {
        const { data } = await client.query<{
            articleIdsForPersona: PersonaQueryResult;
        }>({
            query: GET_ARTICLE_IDS_FOR_PERSONA,
            variables: { query },
            fetchPolicy: 'no-cache',
        });
        return data?.articleIdsForPersona ?? { topicResults: [], headlineResults: [] };
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
            // See getArticleIdsForTopics: the feed layer records the lock, it
            // does not navigate.
            if (isNotSubscribedError(error)) {
                recordAiLocked('hydrate');
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
     * Quota-EXEMPT hydration for articles that reached the device ONLY because
     * the user follows a story. Same payload as
     * {@link getArticlesForTopicsByIds}; the difference is purely billing —
     * nothing fetched here counts against the daily article cap, so there is no
     * `dailyLimitReached`/`resetAt` to report and the caller never has to handle
     * a clipped response.
     *
     * ONLY the feed-sync partition may call this. The caller must have
     * established that every topic which matched these ids is a followed-story
     * topic (see `partitionStoryIds` in feed-sync-steps) — the server cannot
     * verify that claim without persisting a user→topic link, which the privacy
     * invariant forbids, so correctness of the exemption lives here.
     *
     * CHUNK is 50 to match the server's hard per-request ceiling on this query
     * exactly (the metered sibling has no such cap — its quota is its cap).
     */
    static async getArticlesForStories(
        articleIds: string[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<{ articles: ArticleWithClusters[] }> {
        if (articleIds.length === 0) return { articles: [] };

        // Must not exceed MAX_STORY_ARTICLE_IDS_PER_REQUEST on the server (50);
        // a larger batch is rejected with BAD_USER_INPUT, not silently trimmed.
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
                            articlesForStories: ArticlesForTopicsByIdsResponse;
                        }>({
                            query: GET_ARTICLES_FOR_STORIES,
                            variables: { articleIds: batch },
                            fetchPolicy: 'no-cache',
                        });
                        const rows = data?.articlesForStories?.articles ?? [];
                        if (rows.length) results.push(...rows);
                        completedIds += batch.length;
                        onProgress?.(completedIds, articleIds.length);
                    }
                },
            );
            await Promise.all(workers);
            return { articles: results };
        } catch (error) {
            // Same policy as the metered sibling: SubscriptionGuard still
            // applies to this query, so a NotSubscribed error still records the
            // lock (tracked stories the device already holds stay readable).
            if (isNotSubscribedError(error)) {
                recordAiLocked('stories');
                throw error;
            }
            logger.addBreadcrumb(
                '[ArticleService] getArticlesForStories FAILED',
                'article-service',
                { method: 'getArticlesForStories', idCount: articleIds.length },
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
    static async getRelatedArticles(
        articleId: string,
        stableClusterId?: string,
    ): Promise<ArticleSummary[]> {
        try {
            const { data } = await client.query<{ relatedArticles: ArticleSummary[] }>({
                query: GET_RELATED_ARTICLES,
                // Prefer the retained stable-story id: the server maps it to the
                // current clustering generation, so related siblings stay aligned
                // with the size the headline card advertised even after re-clustering.
                variables: { articleId, stableClusterId },
                fetchPolicy: 'no-cache',
            });
            return data?.relatedArticles ?? [];
        } catch (error) {
            this.reportQueryError('getRelatedArticles', error, { articleId, stableClusterId });
            throw error;
        }
    }

    /**
     * Fetch a single article by ID. Returns null if the server has TTL'd it
     * out or the ID is unknown — the caller treats that as the not-found
     * state.
     */
    static async getArticleById(
        articleId: string,
        withFactCheck = false,
    ): Promise<NewsArticle | null> {
        try {
            const { data } = await client.query<{ articleById: NewsArticle | null }>({
                query: GET_ARTICLE_BY_ID,
                // Defaults to FALSE, matching the setting's own default. A
                // caller that forgets the flag gets the private behaviour, not
                // the chatty one.
                variables: { id: articleId, withFactCheck },
                fetchPolicy: 'no-cache',
            });
            return data?.articleById ?? null;
        } catch (error) {
            this.reportQueryError('getArticleById', error, { articleId });
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
            this.reportQueryError('getArticlesForCluster', error, { clusterId, articleIdsToExclude });
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
            this.reportQueryError('getArticlesForPublicationSource', error, { publicationSourceId });
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
            this.reportQueryError('getArticlesForCountry', error, { countryCode });
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
            this.reportQueryError('getTopHeadlinesForCountry', error, { countryCode });
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
            this.reportQueryError('getArticlesForPublisher', error, { newsPublisherId });
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
            this.reportQueryError('getNewsClusters', error, { options });
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
            this.reportQueryError('getNewsClustersForTopicText', error, { topicText });
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
            this.reportQueryError('getNewsClusterForArticle', error, { articleId });
            throw error;
        }
    }

}

export default ArticleService;
