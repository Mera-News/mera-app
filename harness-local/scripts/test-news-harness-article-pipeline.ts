// Node-only harness runner for the full article relevance pipeline against a
// real GraphQL news API + NEAR AI endpoint (or a replayed prior run).
//
//   npx tsx harness-local/scripts/test-news-harness-article-pipeline.ts \
//     --label my-run [--facts <path>] [--limit-per-topic 20] \
//     [--articles-from <runDir>] [--config overrides.json]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessEnv } from '../config/env';
import { ensureLocalTestData, defaultPersonaPath } from '../config/local-data';
import { getAuthHeaders } from '../adapters/auth';
import { createGraphqlNewsApi } from '../adapters/graphql-news-api';
import { createNearAiLlm, type LlmCallRecord } from '../adapters/nearai-llm';
import { createFilePersonaStore } from '../adapters/file-persona-store';
import { createMemorySink } from '../adapters/memory-suggestion-sink';
import { consoleLogger } from '../adapters/console-logger';
import { createRunWriter, captureGitSha } from '../lib/run-writer';
import {
  runArticlePipeline,
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
  type PipelinePorts,
  type PipelineStage,
  type NewsApiPort,
  type HarnessArticle,
} from '../../lib/news-harness';

interface Args {
  label: string;
  facts: string;
  limitPerTopic?: number;
  articlesFrom?: string;
  configPath?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { label: 'run', facts: defaultPersonaPath() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--facts') args.facts = argv[++i] ?? args.facts;
    else if (a === '--limit-per-topic') args.limitPerTopic = Number(argv[++i]);
    else if (a === '--articles-from') args.articlesFrom = argv[++i];
    else if (a === '--config') args.configPath = argv[++i];
  }
  return args;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Replay NewsApiPort: answers from a prior run's article-ids.json + articles.json,
 *  so no live GraphQL query (and no daily quota) is consumed. */
function createReplayNewsApi(runDir: string): NewsApiPort {
  const idsFile = readJson<{
    results: {
      topicText: string;
      articleIds: string[];
      hasNextPage?: boolean;
      nextCursor?: string | null;
    }[];
  }>(join(runDir, 'article-ids.json'));
  const articles = readJson<HarnessArticle[]>(join(runDir, 'articles.json'));
  const byId = new Map(articles.map((a) => [a._id, a]));

  return {
    async getArticleIdsForTopics() {
      return {
        results: idsFile.results.map((r) => ({
          topicText: r.topicText,
          articleIds: r.articleIds,
          hasNextPage: r.hasNextPage ?? false,
          nextCursor: r.nextCursor ?? null,
        })),
      };
    },
    async getArticlesForTopicsByIds(ids: string[]) {
      return {
        articles: ids
          .map((id) => byId.get(id))
          .filter((a): a is HarnessArticle => Boolean(a)),
        dailyLimitReached: false,
        resetAt: null,
      };
    },
  };
}

function mergeConfig(overridesPath?: string, limitPerTopic?: number): ArticlePipelineConfig {
  const base = DEFAULT_HARNESS_CONFIG.articlePipeline;
  const overrides = overridesPath ? readJson<Partial<ArticlePipelineConfig>>(overridesPath) : {};
  const merged: ArticlePipelineConfig = { ...base, ...overrides };
  if (typeof limitPerTopic === 'number' && !Number.isNaN(limitPerTopic)) {
    merged.limitPerTopic = limitPerTopic;
  }
  return merged;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function main(): Promise<number> {
  ensureLocalTestData();
  const args = parseArgs(process.argv.slice(2));
  const env = loadHarnessEnv();
  const config = mergeConfig(args.configPath, args.limitPerTopic);
  const model = env.model ?? config.model;

  // --- News API: live GraphQL or replay stub. ---
  let newsApi: NewsApiPort;
  if (args.articlesFrom) {
    consoleLogger.info(`[article-pipeline] replaying articles from ${args.articlesFrom}`);
    newsApi = createReplayNewsApi(args.articlesFrom);
  } else {
    const headers = await getAuthHeaders(env);
    newsApi = createGraphqlNewsApi({ endpoint: env.graphqlEndpoint, headers });
  }

  const llmCalls: LlmCallRecord[] = [];
  const llm = createNearAiLlm({
    apiKey: env.nearAiApiKey,
    baseUrl: env.nearAiBaseUrl,
    defaultModel: model,
    onCall: (rec) => llmCalls.push(rec),
  });
  const sink = createMemorySink();
  const personaStore = createFilePersonaStore(args.facts);

  const writer = createRunWriter({ label: args.label });
  writer.writeJson('config', {
    target: env.target,
    model,
    articlePipeline: config,
    gitSha: captureGitSha(),
    factsPath: args.facts,
    replayFrom: args.articlesFrom ?? null,
  });

  const ports: PipelinePorts = { llm, newsApi, personaStore, sink, logger: consoleLogger };

  // Stream the streaming artifacts as each stage completes.
  const streamStages: Partial<Record<PipelineStage, string>> = {
    topics: 'topics',
    'article-ids': 'article-ids',
    articles: 'articles',
    candidates: 'candidates',
  };
  const report = await runArticlePipeline(ports, config, {
    onStage: (stage, data) => {
      const file = streamStages[stage];
      if (file) writer.writeJson(file, data);
    },
  });

  // scores.json — the rich per-article view assembled from the final report.
  writer.writeJson('scores', report.scores);
  writer.writeJson('llm-calls', llmCalls);

  const rawScores = report.scores
    .map((s) => s.rawScore)
    .filter((n): n is number => typeof n === 'number');
  const meanRaw =
    rawScores.length > 0 ? rawScores.reduce((a, b) => a + b, 0) / rawScores.length : null;
  const usage = llmCalls.reduce(
    (acc, c) => ({
      promptTokens: acc.promptTokens + (c.usage?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (c.usage?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );
  const discardRate =
    report.counts.scored > 0 ? report.counts.discarded / report.counts.scored : 0;

  const summary = {
    counts: report.counts,
    buckets: report.buckets,
    discardRate,
    meanRawScore: meanRaw,
    medianRawScore: median(rawScores),
    dailyLimitReached: report.dailyLimitReached,
    resetAt: report.resetAt,
    usage,
    llmCallCount: llmCalls.length,
    wallTimeMs: report.timings.totalMs,
    stageTimingsMs: report.timings.stages,
  };
  writer.finish(summary);

  // --- Readable stdout summary. ---
  // eslint-disable-next-line no-console
  console.log('\nArticle pipeline run summary');
  // eslint-disable-next-line no-console
  console.table({
    candidates: report.counts.candidates,
    eligible: report.counts.eligible,
    scored: report.counts.scored,
    kept: report.counts.kept,
    discarded: report.counts.discarded,
    reasoned: report.counts.reasoned,
    failed: report.counts.failed,
    dailyLimitReached: report.dailyLimitReached,
    meanRawScore: meanRaw ?? 0,
    wallTimeMs: report.timings.totalMs,
  });
  // eslint-disable-next-line no-console
  console.table(report.buckets);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
