// computeAndScore with an injected RelevanceScorer (Kev on-device): the scorer
// replaces the LLM call, and the shared penalties still apply to its score.

import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import type { LlmPort } from '@/lib/news-harness/core/ports';
import type { ScoringCandidate } from '@/lib/news-harness/core/types';
import {
  computeAndScore,
  type RelevanceScorer,
  type StageCandidate,
} from '@/lib/news-harness/scoring-engine/run-stage';
import type {
  PersonaScoringContext,
  SoftSuppression,
} from '@/lib/news-harness/scoring-engine/persona-context';
import type { ScoredCandidateInput } from '@/lib/news-harness/scoring-engine/relevance';

const NOW_MS = 1_752_700_000_000;
const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

const sup = (over: Partial<SoftSuppression> = {}): SoftSuppression => ({
  keywords: [],
  strength: 1,
  ...over,
});

function persona(over: Partial<PersonaScoringContext> = {}): PersonaScoringContext {
  return { locations: [], pubPrefs: new Map(), softSuppressions: [], hardSuppressions: [], ...over };
}

function cand(id: string, over: Partial<ScoredCandidateInput> = {}): StageCandidate {
  const input: ScoredCandidateInput = {
    id,
    titleEn: 'Nvidia unveils a new GPU',
    descriptionEn: 'The chipmaker announced it in Taipei.',
    publicationName: 'The Verge',
    countryCode: 'US',
    category: 'technology',
    pubDateMs: NOW_MS - 3_600_000,
    maxClusterSize: 4,
    geoTags: [],
    entities: [],
    matchedTopics: [{ topicId: 't1', text: 'AI hardware', effectiveWeight: 0.8 }],
    ...over,
  };
  const legacy: ScoringCandidate = {
    id,
    titleEn: input.titleEn ?? null,
    descriptionEn: input.descriptionEn ?? null,
    countryCode: 'US',
    userTopicIds: [],
    relatedFacts: [],
  };
  return { input, legacy };
}

function llmSpy() {
  const batchComplete = jest.fn(async () => []);
  const llm: LlmPort = { batchComplete, complete: async () => '' };
  return { llm, batchComplete };
}

function run(
  cands: StageCandidate[],
  p: PersonaScoringContext,
  scorer: RelevanceScorer,
  facts?: string[],
) {
  const { llm, batchComplete } = llmSpy();
  const res = computeAndScore(cands, p, llm, DEFAULT_HARNESS_CONFIG, {
    nowMs: NOW_MS,
    relevanceScorer: scorer,
    factStatements: facts,
  });
  return { res, batchComplete };
}

describe('computeAndScore with a relevanceScorer', () => {
  it('applies the scorer score minus the soft suppression penalty', async () => {
    const scorer: RelevanceScorer = async () => new Map([['a', 0.9]]);
    const { res, batchComplete } = run(
      [cand('a')],
      persona({ softSuppressions: [sup({ keywords: ['nvidia'] })] }),
      scorer,
    );
    const out = await res;
    expect(out.rawScoreMap.get('a')).toBeCloseTo(0.9 - ENG.P_SUP, 10);
    expect(batchComplete).not.toHaveBeenCalled();
  });

  it('writes the scorer score untouched when no filter matches', async () => {
    const { res } = run([cand('a')], persona(), async () => new Map([['a', 0.77]]));
    expect((await res).rawScoreMap.get('a')).toBe(0.77);
  });

  it('gives an id the scorer does not return no score at all, never its math score', async () => {
    const { res } = run([cand('a'), cand('b')], persona(), async () => new Map([['a', 0.8]]));
    const out = await res;
    expect(out.rawScoreMap.get('a')).toBe(0.8);
    expect(out.rawScoreMap.has('b')).toBe(false);
    // The math score is still computed, for the audit columns.
    expect(out.computedScoreMap.has('b')).toBe(true);
  });

  it('floors an exempt top headline at HEADLINE_BASE_FLOOR', async () => {
    const { res } = run(
      [cand('h', { headlineScope: 'GLOBAL' })],
      persona({ hardSuppressions: [sup({ keywords: ['nvidia'] })] }),
      async () => new Map([['h', 0.05]]),
    );
    const out = await res;
    expect(out.excludedIds.has('h')).toBe(false);
    expect(out.rawScoreMap.get('h')).toBe(ENG.HEADLINE_BASE_FLOOR);
  });

  it('calls the scorer once with every scorable candidate and the facts', async () => {
    const scorer = jest.fn<ReturnType<RelevanceScorer>, Parameters<RelevanceScorer>>(
      async () => new Map(),
    );
    const noLegacy: StageCandidate = { input: cand('c').input };
    const { res } = run([cand('a'), cand('b'), noLegacy], persona(), scorer, ['f1']);
    await res;
    expect(scorer).toHaveBeenCalledTimes(1);
    expect(scorer.mock.calls[0][0].map((c) => c.id)).toEqual(['a', 'b']);
    expect(scorer.mock.calls[0][1]).toEqual(['f1']);
  });
});
