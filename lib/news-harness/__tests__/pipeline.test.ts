// End-to-end article pipeline over in-memory fake ports. No module mocks — the
// harness is dependency-free; LLM / news API / persona store / sink are injected.

import {
  runArticlePipeline,
  bucketNameForRaw,
  type PipelinePorts,
  type PipelineStage,
} from '../article-pipeline/pipeline';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import type {
  BatchCall,
  BatchCompletionResult,
  Fact,
  HarnessArticle,
} from '../core/types';
import type { LlmPort, NewsApiPort, PersonaStorePort } from '../core/ports';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

function fact(
  partial: Partial<Fact> & { id: string; statement: string },
): Fact {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Fact;
}

function article(
  partial: Partial<HarnessArticle> & { _id: string },
): HarnessArticle {
  return {
    title_en: `title-${partial._id}`,
    description_en: `desc-${partial._id}`,
    country_code: 'US',
    pubDate: '2026-01-01T00:00:00.000Z',
    clusters: [],
    ...partial,
  } as HarnessArticle;
}

/** Fake LLM that answers score chunks from an ordered eligible-id slice and
 *  reason calls per candidate id — mirroring reconstructLookups' chunk math. */
function makeLlm(opts: {
  eligibleIds: string[];
  chunkSize: number;
  scoresById: Record<string, number>;
  reasonsById?: Record<string, string>;
  failScoreChunks?: Set<number>;
}): LlmPort & { batches: BatchCall[][] } {
  const batches: BatchCall[][] = [];
  const port: LlmPort & { batches: BatchCall[][] } = {
    batches,
    async batchComplete(calls: BatchCall[]): Promise<BatchCompletionResult[]> {
      batches.push(calls);
      return calls.map((call) => {
        if (call.id.startsWith('score:')) {
          const n = Number(call.id.slice('score:'.length));
          if (opts.failScoreChunks?.has(n)) {
            return { id: call.id, output: '', error: 'chunk boom' };
          }
          const slice = opts.eligibleIds.slice(
            n * opts.chunkSize,
            n * opts.chunkSize + opts.chunkSize,
          );
          return {
            id: call.id,
            output: JSON.stringify(slice.map((cid) => opts.scoresById[cid] ?? 0)),
          };
        }
        // reason:<id>
        const cid = call.id.slice('reason:'.length);
        const reason = opts.reasonsById?.[cid] ?? `reason for ${cid}`;
        return { id: call.id, output: JSON.stringify(reason) };
      });
    },
    async complete() {
      return '';
    },
  };
  return port;
}

function makeNewsApi(opts: {
  idsResults: { topicText: string; articleIds: string[] }[];
  articlesById: Record<string, HarnessArticle>;
  dailyLimitOnChunk?: number;
  resetAt?: string;
}): NewsApiPort & {
  idTopicsSeen: { topicText: string }[][];
  limitSeen: (number | undefined)[];
} {
  const idTopicsSeen: { topicText: string }[][] = [];
  const limitSeen: (number | undefined)[] = [];
  let chunkIndex = -1;
  return {
    idTopicsSeen,
    limitSeen,
    async getArticleIdsForTopics(topics, o) {
      idTopicsSeen.push(topics);
      limitSeen.push(o?.limitPerTopic);
      return {
        results: opts.idsResults.map((r) => ({
          topicText: r.topicText,
          articleIds: r.articleIds,
          hasNextPage: false,
          nextCursor: null,
        })),
      };
    },
    async getArticlesForTopicsByIds(ids) {
      chunkIndex += 1;
      const articles = ids
        .map((id) => opts.articlesById[id])
        .filter((a): a is HarnessArticle => Boolean(a));
      const dailyLimitReached = chunkIndex === opts.dailyLimitOnChunk;
      return {
        articles,
        dailyLimitReached,
        resetAt: dailyLimitReached ? (opts.resetAt ?? null) : null,
      };
    },
  };
}

function makePersonaStore(facts: Fact[]): PersonaStorePort {
  return {
    async getFacts() {
      return facts;
    },
    async updateFactMetadata() {
      /* no-op */
    },
  };
}

function makeSink() {
  const scores: { id: string; relevance: number; rawScore: number }[] = [];
  const reasons: { id: string; reason: string }[] = [];
  return {
    scores,
    reasons,
    async saveScores(entries: { id: string; relevance: number; rawScore: number }[]) {
      scores.push(...entries);
    },
    async saveReasons(entries: { id: string; reason: string }[]) {
      reasons.push(...entries);
    },
  };
}

// Shared happy-path fixture: 2 facts, 3 articles, one score chunk.
function happyFixture() {
  const facts = [
    fact({ id: 'f1', statement: 'Works in AI', metadata: { topics: ['AI'] } }),
    fact({ id: 'f2', statement: 'Likes ML', metadata: { topics: ['ML'] } }),
  ];
  const idsResults = [
    { topicText: 'AI', articleIds: ['a1', 'a2'] },
    { topicText: 'ML', articleIds: ['a2', 'a3'] },
  ];
  const articlesById = {
    a1: article({ _id: 'a1' }),
    a2: article({ _id: 'a2' }),
    a3: article({ _id: 'a3' }),
  };
  // Article/eligible order follows articleToTopicTexts key order: a1, a2, a3.
  const eligibleIds = ['a1', 'a2', 'a3'];
  return { facts, idsResults, articlesById, eligibleIds };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runArticlePipeline — happy path', () => {
  it('scores + reasons persisted, report counts + buckets correct', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = happyFixture();
    const llm = makeLlm({
      eligibleIds,
      chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
      scoresById: { a1: 0.85, a2: 0.5, a3: 0.2 },
      reasonsById: { a1: 'AI matters to you', a2: 'ML is relevant' },
    });
    const newsApi = makeNewsApi({ idsResults, articlesById });
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm,
      newsApi,
      personaStore: makePersonaStore(facts),
      sink,
    };

    const stagesSeen: PipelineStage[] = [];
    const report = await runArticlePipeline(ports, ARTICLE_CFG, {
      onStage: (stage) => stagesSeen.push(stage),
    });

    // Passed limitPerTopic + topics through to the news API.
    expect(newsApi.limitSeen[0]).toBe(ARTICLE_CFG.limitPerTopic);
    expect(newsApi.idTopicsSeen[0]).toEqual([
      { topicText: 'AI' },
      { topicText: 'ML' },
    ]);

    expect(report.counts).toMatchObject({
      facts: 2,
      topics: 2,
      articleIds: 3,
      articles: 3,
      candidates: 3,
      eligible: 3,
      ineligible: 0,
      scored: 3,
      kept: 2, // a1 (0.85) + a2 (0.5) clear discardFloor 0.4
      discarded: 1, // a3 (0.2)
      reasoned: 2,
      failed: 0,
    });
    expect(report.buckets).toEqual({
      DISCARD: 1,
      LOW: 1,
      MEDIUM: 0,
      HIGH: 1,
      EMERGENCY: 0,
    });

    // Scores persisted for every non-failed candidate (bucketed relevance + raw).
    expect(sink.scores).toEqual([
      { id: 'a1', relevance: ARTICLE_CFG.highPriorityScore, rawScore: 0.85 },
      { id: 'a2', relevance: ARTICLE_CFG.lowPriorityScore, rawScore: 0.5 },
      { id: 'a3', relevance: 0.2, rawScore: 0.2 },
    ]);

    // Reasons only for the impactful subset (a1, a2).
    expect(sink.reasons).toEqual([
      { id: 'a1', reason: 'AI matters to you' },
      { id: 'a2', reason: 'ML is relevant' },
    ]);

    // A reason call was NOT made for the discarded row.
    const reasonCallIds = llm.batches.flat().map((c) => c.id);
    expect(reasonCallIds).toContain('reason:a1');
    expect(reasonCallIds).not.toContain('reason:a3');

    // All stages emitted in order, ending in 'done'.
    expect(stagesSeen).toEqual([
      'facts',
      'topics',
      'article-ids',
      'articles',
      'candidates',
      'relevance',
      'scores',
      'reasons',
      'done',
    ]);
    expect(report.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(report.scores.find((s) => s.id === 'a1')?.bucket).toBe('HIGH');
  });

  it('runs with default config + no hooks', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = happyFixture();
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm: makeLlm({
        eligibleIds,
        chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
        scoresById: { a1: 0.9, a2: 0.7, a3: 0.5 },
      }),
      newsApi: makeNewsApi({ idsResults, articlesById }),
      personaStore: makePersonaStore(facts),
      sink,
    };
    const report = await runArticlePipeline(ports);
    expect(report.counts.candidates).toBe(3);
    expect(sink.scores).toHaveLength(3);
  });
});

describe('runArticlePipeline — daily limit', () => {
  it('surfaces dailyLimitReached and keeps what was hydrated', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = happyFixture();
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm: makeLlm({
        eligibleIds: ['a1', 'a2'],
        chunkSize: 1,
        scoresById: { a1: 0.9, a2: 0.9 },
      }),
      // hydrateChunkSize=1 → 3 chunks; the 2nd chunk (index 1) reports the cap.
      newsApi: makeNewsApi({
        idsResults,
        articlesById,
        dailyLimitOnChunk: 1,
        resetAt: '2026-07-17T00:00:00.000Z',
      }),
      personaStore: makePersonaStore(facts),
      sink,
    };

    const report = await runArticlePipeline(
      ports,
      { ...ARTICLE_CFG, hydrateChunkSize: 1, articlesPerScorePrompt: 1 },
    );

    expect(report.dailyLimitReached).toBe(true);
    expect(report.resetAt).toBe('2026-07-17T00:00:00.000Z');
    // a3 was never hydrated (loop broke after the capped chunk).
    expect(report.counts.articles).toBe(2);
    expect(report.articles.map((a) => a._id)).toEqual(['a1', 'a2']);
  });
});

describe('runArticlePipeline — LLM chunk failure', () => {
  it('populates failedIds and falls back per decodeCloudBatchResults', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = happyFixture();
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm: makeLlm({
        eligibleIds,
        chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
        scoresById: {},
        failScoreChunks: new Set([0]),
      }),
      newsApi: makeNewsApi({ idsResults, articlesById }),
      personaStore: makePersonaStore(facts),
      sink,
    };

    const report = await runArticlePipeline(ports, ARTICLE_CFG);

    expect(report.counts.failed).toBe(3);
    expect(report.failedIds.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(report.counts.scored).toBe(0);
    expect(report.counts.kept).toBe(0);
    // Failed rows never get persisted scores or reasons.
    expect(sink.scores).toHaveLength(0);
    expect(sink.reasons).toHaveLength(0);
    // Every row carries the fallback relevance and is flagged failed.
    for (const s of report.scores) {
      expect(s.rawScore).toBe(ARTICLE_CFG.fallbackRelevance);
      expect(s.failed).toBe(true);
      expect(s.kept).toBe(false);
    }
    // Fallback 0.3 < discardFloor → all DISCARD.
    expect(report.buckets.DISCARD).toBe(3);
  });
});

describe('bucketNameForRaw', () => {
  it('maps every band, using the default config when omitted', () => {
    expect(bucketNameForRaw(0.1)).toBe('DISCARD');
    expect(bucketNameForRaw(0.5)).toBe('LOW');
    expect(bucketNameForRaw(0.7)).toBe('MEDIUM');
    expect(bucketNameForRaw(0.9)).toBe('HIGH');
    expect(bucketNameForRaw(1.05)).toBe('EMERGENCY');
  });
});

describe('runArticlePipeline — mixed buckets + ineligible row', () => {
  it('counts every band and emits null score rows for ineligible articles', async () => {
    const facts = [
      fact({ id: 'f1', statement: 'Works in AI', metadata: { topics: ['AI'] } }),
    ];
    const idsResults = [
      { topicText: 'AI', articleIds: ['a1', 'a2', 'a3', 'a4'] },
    ];
    const articlesById = {
      a1: article({ _id: 'a1' }),
      a2: article({ _id: 'a2' }),
      a3: article({ _id: 'a3' }),
      // a4 has no description → ineligible for scoring.
      a4: article({ _id: 'a4', description_en: null }),
    };
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm: makeLlm({
        eligibleIds: ['a1', 'a2', 'a3'],
        chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
        scoresById: { a1: 1.05, a2: 0.7, a3: 0.85 },
      }),
      newsApi: makeNewsApi({ idsResults, articlesById }),
      personaStore: makePersonaStore(facts),
      sink,
    };

    const report = await runArticlePipeline(ports, ARTICLE_CFG);

    expect(report.counts.candidates).toBe(4);
    expect(report.counts.eligible).toBe(3);
    expect(report.counts.ineligible).toBe(1);
    expect(report.buckets).toEqual({
      DISCARD: 0,
      LOW: 0,
      MEDIUM: 1,
      HIGH: 1,
      EMERGENCY: 1,
    });
    const a4 = report.scores.find((s) => s.id === 'a4');
    expect(a4).toMatchObject({
      rawScore: null,
      bucketedScore: null,
      bucket: null,
      kept: false,
      failed: false,
    });
    expect(report.scores.find((s) => s.id === 'a1')?.bucket).toBe('EMERGENCY');
  });
});

describe('runArticlePipeline — no topics', () => {
  it('short-circuits cleanly when facts have no topics', async () => {
    const facts = [fact({ id: 'f1', statement: 'no topics here' })];
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm: makeLlm({ eligibleIds: [], chunkSize: 5, scoresById: {} }),
      newsApi: makeNewsApi({ idsResults: [], articlesById: {} }),
      personaStore: makePersonaStore(facts),
      sink,
    };
    const report = await runArticlePipeline(ports, ARTICLE_CFG);
    expect(report.counts).toMatchObject({
      topics: 0,
      articleIds: 0,
      articles: 0,
      candidates: 0,
      scored: 0,
      reasoned: 0,
    });
    expect(sink.scores).toHaveLength(0);
    expect(sink.reasons).toHaveLength(0);
    expect(report.dailyLimitReached).toBe(false);
  });
});
