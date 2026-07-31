// P8 — SOFT suppression on the BACKSTOP (legacy tiered-LLM) path.
//
// The math path subtracts components.suppressPenalty inside computeRelevance,
// but a backstop candidate's applied score is the LLM's, which overwrote it —
// so a "Shown less" filter used to be computed and then thrown away. Since
// enrichment has never run in prod (no geoTags / entities / eventType on ANY
// article), EVERY article is backstop, i.e. soft suppression was inert for
// every user. These tests pin that the penalty now lands on the persisted score.
//
// The regression contract is the last case: a candidate matching NOTHING must
// be byte-identical to the raw LLM score.

import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import type { LlmPort } from '../../core/ports';
import type { ScoringCandidate } from '../../core/types';
import { computeAndJudge, type StageCandidate } from '../run-stage';
import type { PersonaScoringContext, SoftSuppression } from '../persona-context';
import type { ScoredCandidateInput } from '../relevance';

const NOW_MS = 1_752_700_000_000;
const LLM_SCORE = 0.9;
const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

/** BACKSTOP candidate: no geoTags, no entities, no eventType — exactly the
 *  shape every prod article has today. */
function backstopInput(over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput {
  return {
    id: 'art-1',
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
}

function legacy(id: string): ScoringCandidate {
  return {
    id,
    titleEn: 'Nvidia unveils a new GPU',
    descriptionEn: 'The chipmaker announced it in Taipei.',
    countryCode: 'US',
    userTopicIds: [],
    relatedFacts: [],
  };
}

function stageCandidate(over: Partial<ScoredCandidateInput> = {}): StageCandidate {
  const input = backstopInput(over);
  return { input, legacy: legacy(input.id) };
}

function personaWith(
  soft: SoftSuppression[],
  hard: SoftSuppression[] = [],
): PersonaScoringContext {
  return {
    locations: [],
    pubPrefs: new Map(),
    softSuppressions: soft,
    hardSuppressions: hard,
  };
}

const sup = (over: Partial<SoftSuppression>): SoftSuppression => ({
  keywords: [],
  strength: 1,
  ...over,
});

/** Every `score:N` chunk answers with LLM_SCORE for each of its articles; judge
 *  chunks answer empty (irrelevant — every candidate here is backstop). */
function fixedScoreLlm(perChunk: number[]): LlmPort {
  return {
    batchComplete: async (calls) =>
      calls.map((c) => ({
        id: c.id,
        output: c.id.startsWith('score:') ? JSON.stringify(perChunk) : '',
      })),
    complete: async () => '',
  };
}

async function scoreOne(
  persona: PersonaScoringContext,
  over: Partial<ScoredCandidateInput> = {},
): Promise<number | undefined> {
  const stage = [stageCandidate(over)];
  const res = await computeAndJudge(
    stage,
    persona,
    fixedScoreLlm([LLM_SCORE]),
    DEFAULT_HARNESS_CONFIG,
    { nowMs: NOW_MS },
  );
  expect(res.modeMap.get('art-1')).toBe('backstop');
  return res.rawScoreMap.get('art-1');
}

describe('backstop path — soft suppression penalty', () => {
  it('demotes a candidate that matches a soft filter below one that does not', async () => {
    const unfiltered = await scoreOne(personaWith([]));
    const filtered = await scoreOne(personaWith([sup({ keywords: ['nvidia'] })]));

    expect(unfiltered).toBe(LLM_SCORE);
    expect(filtered).toBeLessThan(unfiltered!);
    expect(filtered).toBeCloseTo(LLM_SCORE - ENG.P_SUP, 10);
  });

  it('scales the penalty by the filter strength (same semantics as the math path)', async () => {
    const half = await scoreOne(personaWith([sup({ keywords: ['nvidia'], strength: 0.5 })]));
    expect(half).toBeCloseTo(LLM_SCORE - ENG.P_SUP * 0.5, 10);
  });

  it('caps the total penalty at P_SUP_CAP with several matching filters', async () => {
    const many = [
      sup({ keywords: ['nvidia'] }),
      sup({ keywords: ['gpu'] }),
      sup({ keywords: ['chipmaker'] }),
      sup({ keywords: ['taipei'] }),
      sup({ kind: 'category', value: 'technology' }),
      sup({ kind: 'publication', value: 'the verge' }),
      sup({ kind: 'topic', value: 'ai hardware' }),
    ];
    // Uncapped this would be 7 × P_SUP; the applied delta must be P_SUP_CAP.
    const capped = await scoreOne(personaWith(many));
    expect(LLM_SCORE - capped!).toBeCloseTo(ENG.P_SUP_CAP, 10);
    expect(7 * ENG.P_SUP).toBeGreaterThan(ENG.P_SUP_CAP);
  });

  it('never drives the applied score below 0', async () => {
    const llm: LlmPort = {
      batchComplete: async (calls) =>
        calls.map((c) => ({
          id: c.id,
          output: c.id.startsWith('score:') ? JSON.stringify([0.1]) : '',
        })),
      complete: async () => '',
    };
    const res = await computeAndJudge(
      [stageCandidate()],
      personaWith([sup({ keywords: ['nvidia'] }), sup({ keywords: ['gpu'] })]),
      llm,
      DEFAULT_HARNESS_CONFIG,
      { nowMs: NOW_MS },
    );
    expect(res.rawScoreMap.get('art-1')).toBe(0);
  });

  it('matches structured kinds that read POPULATED fields; the enrichment-only kinds stay inert', async () => {
    const populated = [
      sup({ kind: 'category', value: 'technology' }),
      sup({ kind: 'publication', value: 'the verge' }),
      sup({ kind: 'topic', value: 'ai hardware' }),
    ];
    for (const s of populated) {
      expect(await scoreOne(personaWith([s]))).toBeCloseTo(LLM_SCORE - ENG.P_SUP, 10);
    }

    // entity / place / event_type read fields that prod never populates — they
    // simply never match. That is correct, not a bug to work around.
    const inert = [
      sup({ kind: 'entity', value: 'nvidia' }),
      sup({ kind: 'place', value: 'taipei' }),
      sup({ kind: 'event_type', value: 'product_launch' }),
    ];
    for (const s of inert) {
      expect(await scoreOne(personaWith([s]))).toBe(LLM_SCORE);
    }
  });

  it('leaves a candidate matching nothing byte-identical to the raw LLM score', async () => {
    const score = await scoreOne(
      personaWith([sup({ keywords: ['amd'] }), sup({ kind: 'category', value: 'sport' })]),
    );
    expect(score).toBe(LLM_SCORE);
  });

  it('does not double-penalise when the LLM chunk fails (math score already carries it)', async () => {
    const failing: LlmPort = {
      batchComplete: async (calls) =>
        calls.map((c) => ({ id: c.id, output: '', error: 'boom' })),
      complete: async () => '',
    };
    const persona = personaWith([sup({ keywords: ['nvidia'] })]);
    const res = await computeAndJudge(
      [stageCandidate()],
      persona,
      failing,
      DEFAULT_HARNESS_CONFIG,
      { nowMs: NOW_MS },
    );
    // Fail-open leaves the computed math score, which already subtracted the
    // penalty exactly once.
    expect(res.rawScoreMap.get('art-1')).toBe(res.computedScoreMap.get('art-1'));
    expect(res.componentsMap.get('art-1')!.suppressPenalty).toBeCloseTo(ENG.P_SUP, 10);
  });

  it('a HARD filter still EXCLUDES rather than penalises', async () => {
    const res = await computeAndJudge(
      [stageCandidate()],
      personaWith([], [sup({ keywords: ['nvidia'] })]),
      fixedScoreLlm([LLM_SCORE]),
      DEFAULT_HARNESS_CONFIG,
      { nowMs: NOW_MS },
    );
    expect(res.excludedIds.has('art-1')).toBe(true);
    expect(res.rawScoreMap.has('art-1')).toBe(false);
    expect(res.computedScoreMap.has('art-1')).toBe(false);
  });
});
