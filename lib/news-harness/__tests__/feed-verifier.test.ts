// Second-pass FEED verifier — unit tests for the pure builder/parser/applier
// and an end-to-end pipeline integration (demotion applies / fail-open /
// disabled bypass). No module mocks — the harness is dependency-free.

import {
  buildFeedVerifierCalls,
  parseFeedVerifierResponse,
  applyFeedVerifierDecisions,
} from '../article-pipeline/scoring';
import { runArticlePipeline, type PipelinePorts } from '../article-pipeline/pipeline';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import { CLOUD_FEED_VERIFIER_SYSTEM_PROMPT } from '../prompts/prompts';
import type {
  BatchCall,
  BatchCompletionResult,
  Fact,
  HarnessArticle,
  ScoringCandidate,
} from '../core/types';
import type { LlmPort, NewsApiPort, PersonaStorePort } from '../core/ports';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const FACTS = ['Lives in Amsterdam, Netherlands', 'Works in AI'];

function candidate(
  id: string,
  overrides: Partial<ScoringCandidate> = {},
): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description ${id}`,
    countryCode: 'NLD',
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: `related ${id}` }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildFeedVerifierCalls
// ---------------------------------------------------------------------------

describe('buildFeedVerifierCalls', () => {
  it('splits candidates into feedVerifierBatchSize chunks with verify: ids', () => {
    const cfg = { ...ARTICLE_CFG, feedVerifierBatchSize: 2 };
    const cands = ['a', 'b', 'c', 'd', 'e'].map((id) => candidate(id));
    const { calls, verifyIdToCandidates } = buildFeedVerifierCalls(cands, FACTS, cfg);

    expect(calls.map((c) => c.id)).toEqual(['verify:0', 'verify:1', 'verify:2']);
    expect(verifyIdToCandidates.get('verify:0')?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(verifyIdToCandidates.get('verify:2')?.map((c) => c.id)).toEqual(['e']);
  });

  it('wires the verifier system prompt, temperature, and maxTokens', () => {
    const { calls } = buildFeedVerifierCalls([candidate('a')], FACTS, ARTICLE_CFG);
    expect(calls[0].system).toBe(CLOUD_FEED_VERIFIER_SYSTEM_PROMPT);
    expect(calls[0].system).toBe(ARTICLE_CFG.feedVerifierSystemPrompt);
    expect(calls[0].temperature).toBe(ARTICLE_CFG.scoreTemperature);
    expect(calls[0].maxTokens).toBe(ARTICLE_CFG.feedVerifierMaxTokens);
  });

  it('embeds the user facts and each article block in the prompt', () => {
    const { calls } = buildFeedVerifierCalls([candidate('a')], FACTS, ARTICLE_CFG);
    expect(calls[0].prompt).toContain('[User facts] Lives in Amsterdam');
    expect(calls[0].prompt).toContain('===== Article 0 =====');
    expect(calls[0].prompt).toContain('News Title: Title a');
    expect(calls[0].prompt).toMatch(/Return a JSON array of 1 objects/);
  });

  it('skips ineligible candidates (no body/facts)', () => {
    const cands = [
      candidate('a'),
      candidate('b', { descriptionEn: null }),
      candidate('c', { relatedFacts: [] }),
    ];
    const { verifyIdToCandidates } = buildFeedVerifierCalls(cands, FACTS, ARTICLE_CFG);
    expect(verifyIdToCandidates.get('verify:0')?.map((c) => c.id)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// parseFeedVerifierResponse
// ---------------------------------------------------------------------------

describe('parseFeedVerifierResponse', () => {
  it('parses a well-formed {"v":...} array', () => {
    const out = '[{"v":"yes"},{"v":"no"},{"v":"yes"}]';
    expect(parseFeedVerifierResponse(out, 3)).toEqual(['yes', 'no', 'yes']);
  });

  it('accepts bare "yes"/"no" strings', () => {
    expect(parseFeedVerifierResponse('["no","yes"]', 2)).toEqual(['no', 'yes']);
  });

  it('length mismatch → conservative keep (all yes)', () => {
    // 2 returned, 3 expected.
    expect(parseFeedVerifierResponse('[{"v":"no"},{"v":"no"}]', 3)).toEqual([
      'yes',
      'yes',
      'yes',
    ]);
  });

  it('garbage → conservative keep (all yes)', () => {
    expect(parseFeedVerifierResponse('the model refused', 2)).toEqual(['yes', 'yes']);
  });

  it('unknown label values keep (only explicit "no" demotes)', () => {
    expect(parseFeedVerifierResponse('[{"v":"maybe"},{"v":"NO"}]', 2)).toEqual([
      'yes',
      'no',
    ]);
  });
});

// ---------------------------------------------------------------------------
// applyFeedVerifierDecisions
// ---------------------------------------------------------------------------

describe('applyFeedVerifierDecisions', () => {
  function setup() {
    const cands = [candidate('a'), candidate('b'), candidate('c')];
    const verifyIdToCandidates = new Map([['verify:0', cands]]);
    const scoreMap = new Map([
      ['a', 0.9],
      ['b', 0.6],
      ['c', 0.45],
    ]);
    return { cands, verifyIdToCandidates, scoreMap };
  }

  it('demotes only "no" articles to feedVerifierDemoteScore', () => {
    const { verifyIdToCandidates, scoreMap } = setup();
    const results: BatchCompletionResult[] = [
      { id: 'verify:0', output: '[{"v":"yes"},{"v":"no"},{"v":"no"}]' },
    ];
    const demoted = applyFeedVerifierDecisions(
      scoreMap,
      verifyIdToCandidates,
      results,
      ARTICLE_CFG,
    );
    expect(demoted).toBe(2);
    expect(scoreMap.get('a')).toBe(0.9); // kept
    expect(scoreMap.get('b')).toBe(ARTICLE_CFG.feedVerifierDemoteScore); // 0.28
    expect(scoreMap.get('c')).toBe(ARTICLE_CFG.feedVerifierDemoteScore); // 0.28
  });

  it('a per-chunk error keeps every article in that chunk', () => {
    const { verifyIdToCandidates, scoreMap } = setup();
    const results: BatchCompletionResult[] = [
      { id: 'verify:0', output: '', error: 'boom' },
    ];
    const demoted = applyFeedVerifierDecisions(
      scoreMap,
      verifyIdToCandidates,
      results,
      ARTICLE_CFG,
    );
    expect(demoted).toBe(0);
    expect(scoreMap.get('a')).toBe(0.9);
  });

  it('never raises a score below the demote target', () => {
    const cands = [candidate('a')];
    const verifyIdToCandidates = new Map([['verify:0', cands]]);
    const scoreMap = new Map([['a', 0.1]]); // already below demote target
    applyFeedVerifierDecisions(
      scoreMap,
      verifyIdToCandidates,
      [{ id: 'verify:0', output: '[{"v":"no"}]' }],
      ARTICLE_CFG,
    );
    expect(scoreMap.get('a')).toBe(0.1); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration
// ---------------------------------------------------------------------------

function fact(partial: Partial<Fact> & { id: string; statement: string }): Fact {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Fact;
}

function article(id: string): HarnessArticle {
  return {
    _id: id,
    title_en: `title-${id}`,
    description_en: `desc-${id}`,
    country_code: 'NLD',
    pubDate: '2026-01-01T00:00:00.000Z',
    clusters: [],
  } as HarnessArticle;
}

interface FakeLlmOpts {
  eligibleIds: string[];
  chunkSize: number;
  scoresById: Record<string, number>;
  /** verify:N labels keyed by candidate id. Default: all "yes". */
  verifyById?: Record<string, 'yes' | 'no'>;
  /** Throw on verify calls (fail-open test). */
  failVerify?: boolean;
}

function makeLlm(opts: FakeLlmOpts): LlmPort & { batches: BatchCall[][] } {
  const batches: BatchCall[][] = [];
  return {
    batches,
    async batchComplete(calls: BatchCall[]): Promise<BatchCompletionResult[]> {
      batches.push(calls);
      return calls.map((call) => {
        if (call.id.startsWith('score:')) {
          const n = Number(call.id.slice('score:'.length));
          const slice = opts.eligibleIds.slice(
            n * opts.chunkSize,
            n * opts.chunkSize + opts.chunkSize,
          );
          return {
            id: call.id,
            output: JSON.stringify(slice.map((cid) => opts.scoresById[cid] ?? 0)),
          };
        }
        if (call.id.startsWith('verify:')) {
          if (opts.failVerify) return { id: call.id, output: '', error: 'verify boom' };
          // The verify chunk covers the FEED candidates in submit order; emit a
          // label per candidate. We reconstruct the chunk from eligible order.
          // Simpler: emit labels for every FEED-eligible id, matching the single
          // chunk built by buildFeedVerifierCalls (batchSize default 15 >> N).
          const feedIds = opts.eligibleIds.filter(
            (id) => (opts.scoresById[id] ?? 0) >= ARTICLE_CFG.discardFloor,
          );
          return {
            id: call.id,
            output: JSON.stringify(
              feedIds.map((id) => ({ v: opts.verifyById?.[id] ?? 'yes' })),
            ),
          };
        }
        // reason:<id>
        const cid = call.id.slice('reason:'.length);
        return { id: call.id, output: JSON.stringify(`reason ${cid}`) };
      });
    },
    async complete() {
      return '';
    },
  };
}

function makeNewsApi(
  idsResults: { topicText: string; articleIds: string[] }[],
  articlesById: Record<string, HarnessArticle>,
): NewsApiPort {
  return {
    async getArticleIdsForTopics() {
      return {
        results: idsResults.map((r) => ({
          topicText: r.topicText,
          articleIds: r.articleIds,
          hasNextPage: false,
          nextCursor: null,
        })),
      };
    },
    async getArticlesForTopicsByIds(ids) {
      return {
        articles: ids
          .map((id) => articlesById[id])
          .filter((a): a is HarnessArticle => Boolean(a)),
        dailyLimitReached: false,
        resetAt: null,
      };
    },
  };
}

function makePersonaStore(facts: Fact[]): PersonaStorePort {
  return {
    async getFacts() {
      return facts;
    },
    async updateFactMetadata() {},
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

// 3 articles, one score chunk. a1/a2 land in FEED (≥0.4); a3 is a natural discard.
function fixture() {
  const facts = [fact({ id: 'f1', statement: 'Works in AI', metadata: { topics: ['AI'] } })];
  const idsResults = [{ topicText: 'AI', articleIds: ['a1', 'a2', 'a3'] }];
  const articlesById = { a1: article('a1'), a2: article('a2'), a3: article('a3') };
  return { facts, idsResults, articlesById, eligibleIds: ['a1', 'a2', 'a3'] };
}

describe('runArticlePipeline — FEED verifier stage', () => {
  it('demotes a "no" article to feedVerifierDemoteScore (out of FEED + reasons)', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = fixture();
    const llm = makeLlm({
      eligibleIds,
      chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
      scoresById: { a1: 0.85, a2: 0.62, a3: 0.2 },
      verifyById: { a2: 'no' }, // demote a2
    });
    const sink = makeSink();
    const ports: PipelinePorts = {
      llm,
      newsApi: makeNewsApi(idsResults, articlesById),
      personaStore: makePersonaStore(facts),
      sink,
    };
    // Wave 7b flipped the default feedVerifierEnabled → false (verifier absorbed
    // into the judge). The verifier code is retained for one release; this test
    // explicitly enables it to keep exercising that retained code path.
    const report = await runArticlePipeline(ports, { ...ARTICLE_CFG, feedVerifierEnabled: true });

    const a2 = report.scores.find((s) => s.id === 'a2')!;
    expect(a2.rawScore).toBe(ARTICLE_CFG.feedVerifierDemoteScore); // 0.28
    expect(a2.bucket).toBe('DISCARD'); // 0.28 < discardFloor
    expect(a2.kept).toBe(false);
    // a1 survived the verifier and stays in FEED.
    expect(report.scores.find((s) => s.id === 'a1')!.kept).toBe(true);
    // No reason generated for the demoted row (0.28 < reasonRelevanceThreshold).
    expect(sink.reasons.map((r) => r.id)).toEqual(['a1']);
    // A verify: batch was issued.
    expect(llm.batches.flat().some((c) => c.id.startsWith('verify:'))).toBe(true);
  });

  it('fail-open: verifier LLM error leaves scores unchanged', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = fixture();
    const llm = makeLlm({
      eligibleIds,
      chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
      scoresById: { a1: 0.85, a2: 0.62, a3: 0.2 },
      failVerify: true,
    });
    const sink = makeSink();
    const report = await runArticlePipeline(
      {
        llm,
        newsApi: makeNewsApi(idsResults, articlesById),
        personaStore: makePersonaStore(facts),
        sink,
      },
      { ...ARTICLE_CFG, feedVerifierEnabled: true }, // Wave 7b: default now off; enable to test fail-open.
    );
    expect(report.scores.find((s) => s.id === 'a1')!.rawScore).toBe(0.85);
    expect(report.scores.find((s) => s.id === 'a2')!.rawScore).toBe(0.62);
    expect(report.counts.kept).toBe(2); // a1 + a2 both still FEED
  });

  it('disabled flag bypasses the verifier entirely (no verify: calls)', async () => {
    const { facts, idsResults, articlesById, eligibleIds } = fixture();
    const llm = makeLlm({
      eligibleIds,
      chunkSize: ARTICLE_CFG.articlesPerScorePrompt,
      scoresById: { a1: 0.85, a2: 0.62, a3: 0.2 },
      verifyById: { a2: 'no' }, // would demote if it ran
    });
    const report = await runArticlePipeline(
      {
        llm,
        newsApi: makeNewsApi(idsResults, articlesById),
        personaStore: makePersonaStore(facts),
        sink: makeSink(),
      },
      { ...ARTICLE_CFG, feedVerifierEnabled: false },
    );
    expect(llm.batches.flat().some((c) => c.id.startsWith('verify:'))).toBe(false);
    expect(report.scores.find((s) => s.id === 'a2')!.rawScore).toBe(0.62); // untouched
  });
});
