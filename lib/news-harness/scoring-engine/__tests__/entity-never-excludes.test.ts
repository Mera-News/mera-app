// THE INVARIANT: an `entity`-kind suppression may lower a row's score. It may
// never remove a row, and it may never be the reason a row is not rendered.
//
// Entity extraction measured 68.8% correct on hand audit — roughly one in three
// wrong. Entities are KEPT (the feedback tree's entity like/dislike paths depend
// on them, and the data is fed to the LLM on optimisation runs) but demoted from
// a filter that can delete a suggestion to one that can only nudge a rank.
//
// There are two ways an entity filter could still delete a row, and both are
// covered here:
//   1. HARD EXCLUSION — the screen that writes `excluded`. Blocked twice: the
//      hard/soft partition never files an entity row as hard
//      (`stage-scoring::loadPersonaScoringContext`, tested there), and the
//      screen itself skips them (`canHardExclude`, tested here).
//   2. THE SOFT PENALTY CROSSING THE RENDER GATE — a hard filter wearing a soft
//      filter's clothes. This is the subtle one. The measured worst case is
//      below; the floor is what makes it safe.

import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import {
  applyEntityPenalty,
  computeRelevance,
  splitSuppressionPenalty,
  type ScoredCandidateInput,
} from '../relevance';
import {
  canHardExclude,
  screenHardSuppressions,
  screenHardSuppressionsDetailed,
} from '../suppression';
import type { PersonaScoringContext, SoftSuppression } from '../persona-context';

const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;
const GATE = ENG.ENTITY_PENALTY_FLOOR;
const NOW = 1_700_000_000_000;

const tagged = (over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput => ({
  id: 'a0',
  titleEn: 'Commission opens antitrust case',
  descriptionEn: 'Brussels probe',
  matchedTopics: [],
  geoTags: [{ city: 'brussels', countryCode: 'BEL' }],
  entities: ['european commission', 'margrethe vestager'],
  eventType: 'crime',
  ...over,
});

const persona = (over: Partial<PersonaScoringContext> = {}): PersonaScoringContext => ({
  locations: [],
  pubPrefs: new Map(),
  softSuppressions: [],
  hardSuppressions: [],
  ...over,
});

const entityFilter = (value: string, strength = 1): SoftSuppression => ({
  keywords: [],
  strength,
  kind: 'entity',
  value,
});

// ---------------------------------------------------------------------------
// 1. Entity can never HARD-EXCLUDE
// ---------------------------------------------------------------------------

describe('canHardExclude — the one "may this filter remove a row?" predicate', () => {
  it('is false for entity and true for every other kind', () => {
    expect(canHardExclude(entityFilter('european commission'))).toBe(false);
    const excludingKinds = ['category', 'event_type', 'publication', 'place', 'topic'] as const;
    for (const kind of excludingKinds) {
      expect(canHardExclude({ keywords: [], strength: 1, kind, value: 'x' })).toBe(true);
    }
    // keyword, and a NULL kind that reads as keyword, both still exclude.
    expect(canHardExclude({ keywords: ['nvidia'], strength: 1 })).toBe(true);
  });
});

describe('the hard screen ignores entity filters', () => {
  it('does NOT exclude a row whose only matching hard filter is an entity', () => {
    const dropped = screenHardSuppressions(
      [tagged()],
      [entityFilter('european commission')],
    );
    expect(dropped.size).toBe(0);
  });

  it('does not report it as EXEMPTED either — the card must not be labelled', () => {
    // `exempted` means "matched, kept, tell the user their filter did this".
    // An unreliable entity match is not something to claim on a card.
    const r = screenHardSuppressionsDetailed(
      [tagged({ headlineScope: 'COUNTRY' })],
      [entityFilter('european commission')],
    );
    expect(r.excluded.size).toBe(0);
    expect(r.exempted.size).toBe(0);
  });

  it('still excludes on place and event_type — this change is entity-only', () => {
    // 81.3% and 93.8% on the same audit; the owner scoped the change to
    // entities. A regression that quietly widened it would show up here.
    expect(
      screenHardSuppressions([tagged()], [
        { keywords: [], strength: 1, kind: 'place', value: 'brussels' },
      ]).size,
    ).toBe(1);
    expect(
      screenHardSuppressions([tagged()], [
        { keywords: [], strength: 1, kind: 'event_type', value: 'crime' },
      ]).size,
    ).toBe(1);
  });

  it('a mixed filter list still excludes via the non-entity filter', () => {
    const dropped = screenHardSuppressions([tagged()], [
      entityFilter('european commission'),
      { keywords: [], strength: 1, kind: 'event_type', value: 'crime' },
    ]);
    expect([...dropped.values()]).toEqual(['crime']);
  });
});

// ---------------------------------------------------------------------------
// 2. THE SUBTLE ONE — the soft penalty must not become an exclusion
// ---------------------------------------------------------------------------

describe('the entity penalty is measured, and cannot cross the render gate', () => {
  it('MEASUREMENT: the max entity-driven penalty (0.6) EXCEEDS the gate (0.4)', () => {
    // This is why the floor exists rather than a cap. One entity match is
    // P_SUP·strength = 0.3; two saturate P_SUP_CAP = 0.6. The render gate is
    // 0.4. So a naive subtraction could take a row scoring 0.5 to -0.1 — an
    // entity filter deleting a suggestion, which is exactly the invariant
    // this file defends. No positive cap fixes it either: a row sitting AT the
    // gate is removed by any penalty above zero.
    const { entity } = splitSuppressionPenalty(
      tagged(),
      persona({
        softSuppressions: [
          entityFilter('european commission'),
          entityFilter('margrethe vestager'),
        ],
      }),
      ENG,
    );
    expect(entity).toBeCloseTo(0.6, 10);
    expect(entity).toBe(ENG.P_SUP_CAP);
    expect(entity).toBeGreaterThan(GATE);
  });

  it('applyEntityPenalty floors AT the gate, never below', () => {
    expect(applyEntityPenalty(0.5, 0.6, ENG)).toBeCloseTo(GATE, 10);
    expect(applyEntityPenalty(GATE, 0.6, ENG)).toBeCloseTo(GATE, 10);
    expect(applyEntityPenalty(1.1, 0.6, ENG)).toBeCloseTo(0.5, 10);
  });

  it('leaves an already-sub-gate score untouched', () => {
    // Not renderable anyway; lowering it further is a rank change nobody sees,
    // and floor-by-min must not RAISE it either.
    expect(applyEntityPenalty(0.2, 0.6, ENG)).toBeCloseTo(0.2, 10);
  });

  it('is a no-op when nothing matched', () => {
    expect(applyEntityPenalty(0.75, 0, ENG)).toBe(0.75);
  });

  it('the floor equals the render gate — not an independent number', () => {
    expect(ENG.ENTITY_PENALTY_FLOOR).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline.discardFloor);
  });
});

describe('computeRelevance — an entity filter nudges the score but never removes', () => {
  // A row that actually RENDERS: a saturating topic match puts it well above the
  // gate. Without this the base is BASE_MIN (0.05) and every assertion below
  // would pass vacuously against a row that was never visible.
  const renderable = () =>
    tagged({ matchedTopics: [{ topicId: 't1', text: 'EU tech policy', effectiveWeight: 1 }] });
  const scoring = (softSuppressions: SoftSuppression[]) =>
    computeRelevance(renderable(), persona({ softSuppressions }), ENG, NOW);

  it('lowers the score (rank influence is retained)', () => {
    const clean = scoring([]).score;
    const filtered = scoring([entityFilter('european commission')]).score;
    expect(filtered).toBeLessThan(clean);
  });

  it('never lands below the gate, even with the penalty saturated', () => {
    const r = scoring([
      entityFilter('european commission'),
      entityFilter('margrethe vestager'),
    ]);
    expect(r.components.entityPenalty).toBeCloseTo(0.6, 10);
    expect(r.score).toBeGreaterThanOrEqual(GATE);
  });

  it('keeps the entity share OUT of suppressPenalty', () => {
    // They are reported separately because they are APPLIED differently. A
    // consumer that subtracts `suppressPenalty` outright (run-stage does) must
    // not silently pick up the entity part.
    const r = scoring([entityFilter('european commission')]);
    expect(r.components.suppressPenalty).toBe(0);
    expect(r.components.entityPenalty).toBeCloseTo(ENG.P_SUP, 10);
  });

  it('a NON-entity soft filter can still sink a row below the gate', () => {
    // The contrast that proves the floor is entity-scoped, not a blanket
    // softening of every filter.
    const r = scoring([
      { keywords: [], strength: 1, kind: 'event_type', value: 'crime' },
      { keywords: [], strength: 1, kind: 'place', value: 'brussels' },
    ]);
    expect(r.components.suppressPenalty).toBeCloseTo(0.6, 10);
    expect(r.score).toBeLessThan(GATE);
  });
});
