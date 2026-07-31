// P6 — a TOP HEADLINE passes through a hard "not interested" filter.
//
// Product rule: a filter is about routine coverage, not about hiding major news.
// So a headline-sourced row that matches a HARD filter is DEMOTED, never
// removed — and it is labelled on the card, because a blocked subject appearing
// with no explanation is worse than the feature not existing.
//
// The exemption has to hold at every hard-exclusion point or it fights the
// retroactive purge on every sweep. This file pins the two harness-side points
// (`screenHardSuppressions*` and `computeAndJudge`) plus the demotion itself;
// `lib/mera-protocol/__tests__/headline-exemption-math-stage.test.ts` pins the
// E2EE math stage and `lib/services/__tests__/headline-exemption-sweep.test.ts`
// pins the retroactive purge.
//
// The load-bearing negative is `isHardFilterExempt` being about the HARD list
// only: a headline matching a SOFT filter must still die by the existing
// floor-is-before-penalties rule.

import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import type { LlmPort } from '../../core/ports';
import type { ScoringCandidate } from '../../core/types';
import { computeAndJudge, type StageCandidate } from '../run-stage';
import type { PersonaScoringContext, SoftSuppression } from '../persona-context';
import { computeRelevance, type ScoredCandidateInput } from '../relevance';
import {
  isHardFilterExempt,
  screenHardSuppressions,
  screenHardSuppressionsDetailed,
} from '../suppression';

const NOW_MS = 1_752_700_000_000;
const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;
/** Rows render only above this; a "demotion" that crosses it is an exclusion. */
const RENDER_GATE = 0.3;

const sup = (over: Partial<SoftSuppression> = {}): SoftSuppression => ({
  keywords: [],
  strength: 1,
  ...over,
});

const NVIDIA = sup({ keywords: ['nvidia'] });

function persona(over: Partial<PersonaScoringContext> = {}): PersonaScoringContext {
  return {
    locations: [],
    pubPrefs: new Map(),
    softSuppressions: [],
    hardSuppressions: [],
    ...over,
  };
}

/** MATH-mode candidate (has an eventType ⇒ not backstop), matching `nvidia`. */
function input(over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput {
  return {
    id: 'art-1',
    titleEn: 'Nvidia unveils a new GPU',
    descriptionEn: 'The chipmaker announced it in Taipei.',
    publicationName: 'The Verge',
    countryCode: 'US',
    eventType: 'business',
    category: 'technology',
    pubDateMs: NOW_MS - 3_600_000,
    maxClusterSize: 40, // popComp saturated → the pop lift is at its maximum
    geoTags: [],
    entities: [],
    matchedTopics: [],
    ...over,
  };
}

const headline = (over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput =>
  input({ headlineScope: 'GLOBAL', ...over });

// ---------------------------------------------------------------------------
// The shared predicate + the screen
// ---------------------------------------------------------------------------

describe('isHardFilterExempt — the one predicate', () => {
  it('is true for every headline scope and false for a topic-retrieved row', () => {
    expect(isHardFilterExempt(headline({ headlineScope: 'CITY' }))).toBe(true);
    expect(isHardFilterExempt(headline({ headlineScope: 'COUNTRY' }))).toBe(true);
    expect(isHardFilterExempt(headline({ headlineScope: 'GLOBAL' }))).toBe(true);
    expect(isHardFilterExempt(input())).toBe(false);
    expect(isHardFilterExempt(input({ headlineScope: null }))).toBe(false);
  });
});

describe('screenHardSuppressionsDetailed', () => {
  it('splits a matching headline into `exempted` and a matching normal row into `excluded`', () => {
    const { excluded, exempted } = screenHardSuppressionsDetailed(
      [input({ id: 'normal' }), headline({ id: 'head' })],
      [NVIDIA],
    );
    expect([...excluded.keys()]).toEqual(['normal']);
    expect([...exempted.keys()]).toEqual(['head']);
    // Both carry the display value the card / the log names.
    expect(excluded.get('normal')).toBe('nvidia');
    expect(exempted.get('head')).toBe('nvidia');
  });

  it('leaves non-matching rows out of BOTH maps', () => {
    const { excluded, exempted } = screenHardSuppressionsDetailed(
      [input({ id: 'amd', titleEn: 'AMD ships a GPU' }), headline({ id: 'amd-head', titleEn: 'AMD ships a GPU' })],
      [NVIDIA],
    );
    expect(excluded.size).toBe(0);
    expect(exempted.size).toBe(0);
  });

  it('screenHardSuppressions (the drop list) no longer contains headline rows', () => {
    const drop = screenHardSuppressions([input({ id: 'normal' }), headline({ id: 'head' })], [NVIDIA]);
    expect([...drop.keys()]).toEqual(['normal']);
  });
});

// ---------------------------------------------------------------------------
// The demotion
// ---------------------------------------------------------------------------

describe('computeRelevance — a hard-filtered headline is demoted, not removed', () => {
  it('keeps the row above the render gate but strictly below the same unfiltered headline', () => {
    const clean = computeRelevance(headline(), persona(), ENG, NOW_MS);
    const filtered = computeRelevance(
      headline(),
      persona({ hardSuppressions: [NVIDIA] }),
      ENG,
      NOW_MS,
    );

    expect(filtered.score).toBeGreaterThan(RENDER_GATE);
    expect(filtered.score).toBeLessThan(clean.score);
    // Pinned exactly: the bare headline floor, i.e. the pop lift is forfeited.
    expect(filtered.score).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR, 10);
    expect(clean.score).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR + ENG.HEADLINE_POP_LIFT, 10);
  });

  it('marks the row so the UI can label it, and applies the ONE capped penalty', () => {
    const r = computeRelevance(headline(), persona({ hardSuppressions: [NVIDIA] }), ENG, NOW_MS);
    expect(r.components.hardFilterExempt).toBe(true);
    expect(r.components.suppressPenalty).toBeCloseTo(ENG.P_SUP, 10);
  });

  it('never exceeds P_SUP_CAP however many hard filters match', () => {
    const many = [
      sup({ keywords: ['nvidia'] }),
      sup({ keywords: ['gpu'] }),
      sup({ keywords: ['chipmaker'] }),
      sup({ keywords: ['taipei'] }),
    ];
    const r = computeRelevance(headline(), persona({ hardSuppressions: many }), ENG, NOW_MS);
    expect(r.components.suppressPenalty).toBeCloseTo(ENG.P_SUP_CAP, 10);
    // Still shown: the whole point of the exemption.
    expect(r.score).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR, 10);
  });

  it('leaves a NON-headline row completely untouched (it never reaches the math anyway)', () => {
    const before = computeRelevance(input(), persona(), ENG, NOW_MS);
    const after = computeRelevance(input(), persona({ hardSuppressions: [NVIDIA] }), ENG, NOW_MS);
    // hardSuppressions are screened out upstream, so they must not leak into the
    // penalty for an ordinary row — the score is byte-identical.
    expect(after.score).toBe(before.score);
    expect(after.components.suppressPenalty).toBe(0);
    expect(after.components.hardFilterExempt).toBe(false);
  });

  it('does NOT rescue a headline killed by a SOFT filter (floor stays before penalties)', () => {
    const r = computeRelevance(
      headline(),
      persona({ softSuppressions: [NVIDIA] }),
      ENG,
      NOW_MS,
    );
    expect(r.components.hardFilterExempt).toBe(false);
    expect(r.score).toBeLessThan(RENDER_GATE);
  });

  it('does not demote a headline that matches NO hard filter', () => {
    const r = computeRelevance(
      headline({ titleEn: 'AMD ships a GPU', descriptionEn: 'In Austin.' }),
      persona({ hardSuppressions: [NVIDIA] }),
      ENG,
      NOW_MS,
    );
    expect(r.components.hardFilterExempt).toBe(false);
    expect(r.score).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR + ENG.HEADLINE_POP_LIFT, 10);
  });
});

// ---------------------------------------------------------------------------
// Point 1 of 3 — the computeAndJudge orchestrator
// ---------------------------------------------------------------------------

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

const stage = (i: ScoredCandidateInput): StageCandidate => ({ input: i, legacy: legacy(i.id) });

/** Judge chunks answer nothing (advisory + never applied); score chunks answer
 *  a fixed low LLM score so the backstop floor is observable. */
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

describe('computeAndJudge — hard screen (call site 1 of 3)', () => {
  const run = (candidates: StageCandidate[], p: PersonaScoringContext, llmScores = [0.05]) =>
    computeAndJudge(candidates, p, fixedScoreLlm(llmScores), DEFAULT_HARNESS_CONFIG, {
      nowMs: NOW_MS,
      skipJudge: true,
    });

  it('excludes the normal row and KEEPS the headline row', async () => {
    const res = await run(
      [stage(input({ id: 'normal' })), stage(headline({ id: 'head' }))],
      persona({ hardSuppressions: [NVIDIA] }),
    );

    expect([...res.excludedIds]).toEqual(['normal']);
    expect(res.excludedValueById.get('normal')).toBe('nvidia');

    // The headline survived: excluded rows get NO entry in any map, so a score
    // here is proof it was scored rather than screened.
    expect(res.excludedIds.has('head')).toBe(false);
    expect(res.rawScoreMap.has('head')).toBe(true);
    expect(res.rawScoreMap.get('head')!).toBeGreaterThan(RENDER_GATE);
  });

  it('reports the kept-but-filtered row so the UI can label it', async () => {
    const res = await run([stage(headline({ id: 'head' }))], persona({ hardSuppressions: [NVIDIA] }));
    expect(res.exemptedValueById.get('head')).toBe('nvidia');
    expect(res.componentsMap.get('head')!.hardFilterExempt).toBe(true);
  });

  it('demotes rather than leaves the headline untouched', async () => {
    const clean = await run([stage(headline({ id: 'head' }))], persona());
    const filtered = await run(
      [stage(headline({ id: 'head' }))],
      persona({ hardSuppressions: [NVIDIA] }),
    );
    expect(filtered.rawScoreMap.get('head')!).toBeLessThan(clean.rawScoreMap.get('head')!);
  });

  it('floors an untagged (BACKSTOP) exempt headline too — the LLM score is not enough', async () => {
    // No eventType/entities/geoTags ⇒ backstop ⇒ the applied score is the LLM's,
    // minus the suppression penalty. 0.05 − 0.3 would be 0 without the floor.
    const backstopHeadline = headline({ id: 'head', eventType: null });
    const res = await run(
      [stage(backstopHeadline)],
      persona({ hardSuppressions: [NVIDIA] }),
      [0.05],
    );
    expect(res.modeMap.get('head')).toBe('backstop');
    expect(res.rawScoreMap.get('head')).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR, 10);
  });

  it('is byte-identical to the no-filter path for a backstop row matching nothing', async () => {
    const res = await run(
      [stage(input({ id: 'amd', eventType: null, titleEn: 'AMD ships a GPU' }))],
      persona({ hardSuppressions: [NVIDIA] }),
      [0.42],
    );
    expect(res.rawScoreMap.get('amd')).toBe(0.42);
  });

  it('empty hardSuppressions changes nothing at all', async () => {
    const res = await run([stage(headline({ id: 'head' }))], persona());
    expect(res.excludedIds.size).toBe(0);
    expect(res.exemptedValueById.size).toBe(0);
    expect(res.componentsMap.get('head')!.hardFilterExempt).toBe(false);
  });
});
