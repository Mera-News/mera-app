// harness-local — NewsApiPort implementation backed by the real mera-server
// GraphQL API. Query documents are copied verbatim from lib/article-service.ts
// (GET_ARTICLE_IDS_FOR_TOPICS / GET_ARTICLES_FOR_TOPICS_BY_IDS, stripped of the
// Apollo `gql` tag) and the chunking/concurrency semantics mirror
// ArticleService.getArticleIdsForTopics / getArticlesForTopicsByIds exactly —
// this adapter deliberately does NOT use Apollo Client (no-cache policy, React
// Native deps) since harness-local is a plain Node script runner.

import type { NewsApiPort } from '@/lib/news-harness/core/ports';
import type { HarnessArticle } from '@/lib/news-harness/core/types';

// Copied verbatim (minus the `gql` tag) from lib/article-service.ts ~l.321.
const GET_ARTICLE_IDS_FOR_TOPICS = `
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

// Copied verbatim (minus the `gql` tag) from lib/article-service.ts ~l.339.
const GET_ARTICLES_FOR_TOPICS_BY_IDS = `
  query GetArticlesForTopicsByIds($articleIds: [ID!]!) {
    articlesForTopicsByIds(articleIds: $articleIds) {
      articles {
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
      dailyLimitReached
      resetAt
    }
  }
`;

// Mirrors ArticleService's MAX_TOPICS_PER_BATCH — the server rejects
// articleIdsForTopics requests with more than 200 topics; we stay under that
// cap with headroom and run batches sequentially (each cold topic costs the
// server a Jina embed + vector search).
const MAX_TOPICS_PER_BATCH = 150;
// Mirrors ArticleService.getArticlesForTopicsByIds's CHUNK / CONCURRENCY.
const HYDRATE_CHUNK = 50;
const HYDRATE_CONCURRENCY = 5;

interface GraphqlErrorPayload {
  message: string;
}

interface GraphqlResponseBody<T> {
  data?: T;
  errors?: GraphqlErrorPayload[];
}

async function postGraphql<T>(
  endpoint: string,
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`harness-local GraphQL request failed: ${response.status} ${response.statusText} — ${text}`);
  }

  const body = (await response.json()) as GraphqlResponseBody<T>;
  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `harness-local GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
    );
  }
  if (body.data === undefined) {
    throw new Error('harness-local GraphQL response missing `data`');
  }
  return body.data;
}

export function createGraphqlNewsApi(cfg: {
  endpoint: string;
  headers: Record<string, string>;
}): NewsApiPort {
  async function queryArticleIdsBatch(
    topics: { topicText: string; cursor?: string }[],
    limitPerTopic: number,
  ): Promise<{
    results: {
      topicText: string;
      articleIds: string[];
      hasNextPage: boolean;
      nextCursor?: string | null;
    }[];
  }> {
    const data = await postGraphql<{
      articleIdsForTopics: {
        results: {
          topicText: string;
          articleIds: string[];
          hasNextPage: boolean;
          nextCursor?: string | null;
        }[];
      };
    }>(cfg.endpoint, cfg.headers, GET_ARTICLE_IDS_FOR_TOPICS, {
      topics: topics.map((t) => ({ topicText: t.topicText, afterCursor: t.cursor })),
      limitPerTopic,
    });
    return data.articleIdsForTopics ?? { results: [] };
  }

  return {
    async getArticleIdsForTopics(topics, opts) {
      const limitPerTopic = opts?.limitPerTopic ?? 20;

      if (topics.length <= MAX_TOPICS_PER_BATCH) {
        return queryArticleIdsBatch(topics, limitPerTopic);
      }

      // Chunk sequentially (never in parallel — each cold topic costs the
      // server a Jina embed + vector search), de-duping by topicText so a
      // topic never appears twice — mirrors ArticleService.getArticleIdsForTopics.
      const merged: {
        topicText: string;
        articleIds: string[];
        hasNextPage: boolean;
        nextCursor?: string | null;
      }[] = [];
      const seenTopics = new Set<string>();
      for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_BATCH) {
        const batch = topics.slice(i, i + MAX_TOPICS_PER_BATCH);
        const { results } = await queryArticleIdsBatch(batch, limitPerTopic);
        for (const result of results) {
          if (seenTopics.has(result.topicText)) continue;
          seenTopics.add(result.topicText);
          merged.push(result);
        }
      }
      return { results: merged };
    },

    async getArticlesForTopicsByIds(articleIds) {
      if (articleIds.length === 0) {
        return { articles: [], dailyLimitReached: false };
      }

      const batches: string[][] = [];
      for (let i = 0; i < articleIds.length; i += HYDRATE_CHUNK) {
        batches.push(articleIds.slice(i, i + HYDRATE_CHUNK));
      }

      const articles: HarnessArticle[] = [];
      let dailyLimitReached = false;
      let resetAt: string | null | undefined;

      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(HYDRATE_CONCURRENCY, batches.length) },
        async () => {
          while (true) {
            const idx = nextIndex++;
            if (idx >= batches.length) return;
            const batch = batches[idx];
            const data = await postGraphql<{
              articlesForTopicsByIds: {
                articles: HarnessArticle[];
                dailyLimitReached: boolean;
                resetAt?: string | null;
              };
            }>(cfg.endpoint, cfg.headers, GET_ARTICLES_FOR_TOPICS_BY_IDS, {
              articleIds: batch,
            });
            const result = data.articlesForTopicsByIds;
            if (result?.articles?.length) articles.push(...result.articles);
            if (result?.dailyLimitReached) {
              dailyLimitReached = true;
              // Mirrors ArticleService.getArticlesForTopicsByIds exactly:
              // first non-null resetAt wins across concurrent chunk workers
              // (order is whichever chunk completes first, not necessarily
              // chunk index order).
              resetAt = resetAt ?? result.resetAt ?? undefined;
            }
          }
        },
      );
      await Promise.all(workers);

      return { articles, dailyLimitReached, resetAt };
    },
  };
}
