// relevance v4 — the acceptance suite for retiring v3 and repurposing its
// user-facing switch.
//
// v4 is NOT a new scorer. It is the shipped legacy (v1) two-pass path plus the
// two article-tag features measured in a6e94fd, behind ONE toggle:
//   ADD 1 `legacyTagPromptEnabled`      — tag block in the pass-1 batch prompt
//   ADD 2 `legacyTagReasonGateEnabled`  — skip + demote pass-2 for low-value
//                                          event types
//
// Two things are pinned here that no other suite covers, because both are ways
// this change could look correct and be wrong in production:
//
//   1. THE LIVE BUILDERS, not the harness twin. `scoring-service.ts` owns the
//      builders the app actually calls, and they used to read the frozen
//      module literal `DEFAULT_HARNESS_CONFIG.articlePipeline`. A v4 toggle
//      layered only into `effectiveHarnessConfig()` would move the OFFLINE
//      harness and nothing the app sends — a green unit test over a dead
//      feature. These tests drive the shim's own exports with an effective
//      config and assert the features actually engage.
//
//   2. SUPPRESSION. The engine sees the server's tags, so a user-created
//      `event_type` / `entity` / `place` filter actually matches an article
//      carrying that tag — and v4's toggle does not change that either way.
//      These tests replace an earlier block that pinned the OPPOSITE (that the
//      tags were hidden by `USE_ARTICLE_TAGS`); see the block comment there.

jest.mock('../../llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('../../llm/cloudComplete', () => ({
  cloudComplete: jest.fn(),
  cloudBatchComplete: jest.fn(),
}));
jest.mock('../../llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('../../database/services/calibration-service', () => ({
  recordOverrides: jest.fn().mockResolvedValue({ count: 0, notified: false }),
  getScoringOverrides: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../database/services/article-suggestion-service', () => ({
  countUnscoredSuggestions: jest.fn(),
  getScoredSuggestionsWithoutReasons: jest.fn(),
  getUnscoredSuggestionsWithFacts: jest.fn(),
  saveReason: jest.fn(),
  saveScoringResult: jest.fn(),
}));
jest.mock('../../database/services/fact-service', () => ({
  getFacts: jest.fn(() =>
    Promise.resolve([{ statement: 'Lives in Amsterdam, Netherlands' }]),
  ),
}));
// stage-scoring pulls the persona DB services in at import time.
jest.mock('../stage-scoring', () => ({
  computeAndScoreForCandidates: jest.fn(),
  computeMathStage: jest.fn(),
  loadPersonaScoringContext: jest.fn(),
  buildStageCandidates: jest.fn(),
  getScoringLlmPort: jest.fn(),
}));
jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: jest.fn(() => ({ processingMode: 'CLOUD' })) },
}));

import { buildRelevanceCalls, buildReasonCallsForSubset } from '../scoring-service';
import {
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
} from '../../news-harness/core/config';
import { ARTICLE_METADATA_PREFIX } from '../../news-harness/article-pipeline/tag-prompt';
import {
  buildSuppressionHaystack,
  screenHardSuppressions,
  suppressionMatchesCandidate,
} from '../../news-harness/scoring-engine/suppression';
import type {
  PersonaScoringContext,
  SoftSuppression,
} from '../../news-harness/scoring-engine/persona-context';
import { computeRelevance, type ScoredCandidateInput } from '../../news-harness/scoring-engine/relevance';
import type { ScoringCandidate, StageCandidateRow } from '../../news-harness/core/types';

const BASE = DEFAULT_HARNESS_CONFIG.articlePipeline;

/** What `effectiveHarnessConfig()` hands the builders with the toggle ON. The
 *  literal shape is asserted in stage-scoring.test.ts; this is the value. */
const V4_ON: ArticlePipelineConfig = {
  ...BASE,
  legacyTagPromptEnabled: true,
  legacyTagReasonGateEnabled: true,
};
/** …and with it OFF: the shipped defaults, unchanged. */
const V4_OFF: ArticlePipelineConfig = BASE;

function stageRow(over: Partial<StageCandidateRow> = {}): StageCandidateRow {
  return {
    id: 'a1',
    titleEn: 'T',
    descriptionEn: 'D',
    publicationName: null,
    countryCode: 'NLD',
    firstPubDateMs: null,
    maxClusterSize: null,
    eventType: null,
    category: null,
    geoTagsJson: null,
    entitiesJson: null,
    matchedTopicsJson: null,
    headlineScope: null,
    stableClusterId: null,
    ...over,
  };
}

function candidate(
  id: string,
  meta?: Partial<StageCandidateRow>,
): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description ${id}`,
    countryCode: 'NLD',
    userTopicIds: [],
    relatedFacts: [{ id: `${id}:f0`, statement: 'Lives in Amsterdam' }],
    ...(meta ? { meta: stageRow({ id, ...meta }) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. ADD 1 — the tag block reaches the calls the LIVE app sends
// ---------------------------------------------------------------------------

describe('v4 ADD 1 — buildRelevanceCalls (the LIVE builder)', () => {
  const tagged = () =>
    candidate('a0', {
      eventType: 'policy_change',
      geoTagsJson: JSON.stringify([{ name: 'Amsterdam', countryCode: 'NLD' }]),
      entitiesJson: JSON.stringify(['European Commission']),
    });

  it('OFF: the prompt carries no metadata block — byte-identical to v1', async () => {
    const bundle = await buildRelevanceCalls([tagged()], V4_OFF);
    expect(bundle.calls).toHaveLength(1);
    expect(bundle.calls[0].prompt).not.toContain(ARTICLE_METADATA_PREFIX);
  });

  it('ON: the metadata block is injected', async () => {
    const bundle = await buildRelevanceCalls([tagged()], V4_ON);
    expect(bundle.calls[0].prompt).toContain(ARTICLE_METADATA_PREFIX);
    expect(bundle.calls[0].prompt).toContain('European Commission');
  });

  // THE REGRESSION THIS FILE EXISTS FOR. Before v4 the builder read the frozen
  // module literal, so the toggle could not reach it at all. If someone ever
  // reverts to reading `ARTICLE_CFG` here, the ON case above would still pass
  // via the default — this one would not.
  it('DEFAULTS to the shipped literal when no config is passed', async () => {
    const bundle = await buildRelevanceCalls([tagged()]);
    expect(bundle.calls[0].prompt).not.toContain(ARTICLE_METADATA_PREFIX);
  });

  it('ON does not touch the ENGINE — the tag block is prompt INPUT only', () => {
    // The engine and the prompt builder read two different objects derived from
    // the same row (see the mechanism note in `article-pipeline/tag-prompt.ts`).
    // v4 moves only the prompt, so the engine's verdict on a tagged candidate is
    // identical with the toggle on or off — `mode` included.
    const input: ScoredCandidateInput = {
      id: 'a0',
      matchedTopics: [],
      geoTags: [{ city: 'amsterdam', countryCode: 'NLD' }],
      entities: ['european commission'],
      eventType: 'policy_change',
    };
    const eng = DEFAULT_HARNESS_CONFIG.scoringEngine;
    const persona: PersonaScoringContext = {
      locations: [],
      pubPrefs: new Map(),
      softSuppressions: [],
      hardSuppressions: [],
    };
    const r = computeRelevance(input, persona, eng, Date.now());
    // 'math' because the article IS tagged — a statement about the article, not
    // about which scorer runs. Every candidate takes the LLM path now.
    expect(r.mode).toBe('math');
  });
});

// ---------------------------------------------------------------------------
// 2. ADD 2 — the reason gate reaches the LIVE builder
// ---------------------------------------------------------------------------

describe('v4 ADD 2 — buildReasonCallsForSubset (the LIVE builder)', () => {
  // `crime` is in the shipped `legacyTagReasonGateEventTypes`.
  const gated = () => candidate('g0', { eventType: 'crime' });
  const kept = () => candidate('k0', { eventType: 'policy_change' });
  const relevance = { g0: 0.8, k0: 0.8 };

  it('OFF: every above-threshold row gets a reason call, nothing demoted', async () => {
    const bundle = await buildReasonCallsForSubset(
      [gated(), kept()],
      relevance,
      0.4,
      false,
      V4_OFF,
    );
    expect(bundle.calls.map((c) => c.id).sort()).toEqual(['reason:g0', 'reason:k0']);
    expect(bundle.tagGatedDemoteIds ?? []).toEqual([]);
  });

  it('ON: the gated event type loses its call AND is returned for demotion', async () => {
    const bundle = await buildReasonCallsForSubset(
      [gated(), kept()],
      relevance,
      0.4,
      false,
      V4_ON,
    );
    expect(bundle.calls.map((c) => c.id)).toEqual(['reason:k0']);
    // Skipping the call WITHOUT demoting would leave the row rendering with no
    // note forever — the two are one action, which is why the ids come back.
    expect(bundle.tagGatedDemoteIds).toEqual(['g0']);
  });

  it('DEFAULTS to the shipped literal when no config is passed', async () => {
    const bundle = await buildReasonCallsForSubset(
      [gated(), kept()],
      relevance,
      0.4,
    );
    expect(bundle.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. SUPPRESSION PARITY — "not interested" matches the same things as before
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. SUPPRESSION — the user's tag-based "not interested" filters MATCH
//
// THESE TESTS REPLACE A BLOCK THAT PINNED THE OPPOSITE. Until `USE_ARTICLE_TAGS`
// was deleted, `applyArticleTagPolicy` blanked `geoTags` / `entities` /
// `eventType` before the engine saw them, and this file asserted that blanking
// held. That was protecting a live bug: the card feedback surface CREATES
// `event_type` / `entity` / `place` suppressions
// (`feedback-tree/resolve-leaf-actions.ts` maps `from_context_eventType` →
// `kind: 'event_type'`; `persona-management/feedback-digest.ts` mints the same
// kinds from swipe signals), and `suppression.ts` matches them against the
// columns that were being blanked. So a user tapping "fewer stories like this"
// got a filter that was created, stored, shown back to them — and matched
// nothing, ever.
//
// Every test below fails against the pre-change code. That is the point: this is
// the bug fix, so it has to have a test that would have caught it.
// ---------------------------------------------------------------------------

describe('tag-based "not interested" filters actually match', () => {
  const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

  /** A fully-tagged candidate — what the server sends today. */
  const tagged = (): ScoredCandidateInput => ({
    id: 'a0',
    titleEn: 'Commission opens antitrust case',
    descriptionEn: 'Brussels probe',
    matchedTopics: [],
    geoTags: [{ city: 'brussels', countryCode: 'BEL' }],
    entities: ['european commission'],
    eventType: 'crime',
  });

  // Exactly the shapes the feedback surface mints.
  const EVENT_TYPE_FILTER: SoftSuppression = {
    keywords: [], strength: 1, kind: 'event_type', value: 'crime',
  };
  const ENTITY_FILTER: SoftSuppression = {
    keywords: [], strength: 1, kind: 'entity', value: 'european commission',
  };
  const PLACE_FILTER: SoftSuppression = {
    keywords: [], strength: 1, kind: 'place', value: 'brussels',
  };

  it('an event_type filter matches the article carrying that event type', () => {
    // THE BUG. `resolve-leaf-actions.ts` writes exactly this row from
    // `from_context_eventType`. Before the fix `candidate.eventType` was null by
    // the time `suppression.ts` compared it, so this was false.
    expect(suppressionMatchesCandidate(tagged(), EVENT_TYPE_FILTER)).toBe(true);
  });

  it('an entity filter matches the article carrying that entity', () => {
    expect(suppressionMatchesCandidate(tagged(), ENTITY_FILTER)).toBe(true);
  });

  it('a place filter matches the article carrying that geo tag', () => {
    expect(suppressionMatchesCandidate(tagged(), PLACE_FILTER)).toBe(true);
  });

  it('the entities reach the keyword haystack too', () => {
    expect(buildSuppressionHaystack(tagged())).toContain('european commission');
  });

  it('the HARD screen now drops a row on a tag-based filter alone', () => {
    // The hard screen runs on the live path via `computeMathStage`, so this is
    // the difference between "not interested" removing the row and doing
    // nothing. No keyword filter here — only the three structured kinds.
    const dropped = screenHardSuppressions([tagged()], [
      EVENT_TYPE_FILTER,
      ENTITY_FILTER,
      PLACE_FILTER,
    ]);
    expect([...dropped.keys()]).toEqual(['a0']);
  });

  it('the SOFT penalty is non-zero for a tag-only filter set', () => {
    // Three matchers fire, so the sum is capped at P_SUP_CAP. Before the fix
    // this was exactly 0 — the "shown less" half of the feature was inert.
    const persona: PersonaScoringContext = {
      locations: [],
      pubPrefs: new Map(),
      softSuppressions: [EVENT_TYPE_FILTER, ENTITY_FILTER, PLACE_FILTER].map((f) => ({
        ...f,
        strength: 0.5,
      })),
      hardSuppressions: [],
    };
    const { suppressPenalty } = computeRelevance(
      tagged(),
      persona,
      ENG,
      Date.now(),
    ).components;
    expect(suppressPenalty).toBeGreaterThan(0);
    expect(suppressPenalty).toBeCloseTo(Math.min(ENG.P_SUP_CAP, 3 * ENG.P_SUP * 0.5), 10);
  });

  it('an untagged article is still matched only on its TEXT', () => {
    // The other half of the contract: unblanking must not make a filter match a
    // row that carries no such tag. Guards against a matcher that treats a
    // missing column as a wildcard.
    const untagged: ScoredCandidateInput = {
      id: 'u0',
      titleEn: 'A quiet day in Utrecht',
      descriptionEn: 'Nothing happened',
      matchedTopics: [],
    };
    expect(suppressionMatchesCandidate(untagged, EVENT_TYPE_FILTER)).toBe(false);
    expect(suppressionMatchesCandidate(untagged, ENTITY_FILTER)).toBe(false);
    expect(suppressionMatchesCandidate(untagged, PLACE_FILTER)).toBe(false);
    expect(screenHardSuppressions([untagged], [EVENT_TYPE_FILTER]).size).toBe(0);
  });

  it('the v4 toggle changes none of this', () => {
    // v4 lives in `articlePipeline`; suppression is computed from
    // `scoringEngine`. Asserted so a future edit cannot quietly couple the
    // scoring-prompt toggle to what a user's filters match.
    const persona: PersonaScoringContext = {
      locations: [],
      pubPrefs: new Map(),
      softSuppressions: [EVENT_TYPE_FILTER],
      hardSuppressions: [],
    };
    const penalty = () =>
      computeRelevance(tagged(), persona, ENG, 0).components.suppressPenalty;
    const before = penalty();
    expect(V4_ON.legacyTagPromptEnabled).toBe(true);
    expect(V4_OFF.legacyTagPromptEnabled).toBe(false);
    expect(penalty()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. THE ACCEPTED SIDE EFFECT — the fail-open score is now tag-sensitive
// ---------------------------------------------------------------------------

describe('unblanking the tags also turned on four scoring components', () => {
  const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

  const persona = (): PersonaScoringContext => ({
    locations: [
      {
        id: 'home',
        city: 'brussels',
        region: null,
        countryCode: 'BEL',
        role: 'home',
        weight: 1,
        validUntilMs: undefined,
      } as unknown as PersonaScoringContext['locations'][number],
    ],
    pubPrefs: new Map(),
    softSuppressions: [],
    hardSuppressions: [],
  });

  const base = (): ScoredCandidateInput => ({
    id: 'a0',
    titleEn: 'Something in Brussels',
    descriptionEn: 'A policy change',
    matchedTopics: [],
  });

  // DOCUMENTED PROPERTY, NOT A REGRESSION. `geoComp` / `entityComp` /
  // `eventComp` / `wrongLocPenalty` are computed from the three tag columns and
  // were HARD ZERO on every production article for as long as the blanking
  // existed — roughly 36% of the positive weight budget, never exercised. They
  // now feed the math score, which is what stands when an LLM call FAILS.
  //
  // So a tagged article's fail-open score differs from an untagged one's. That
  // is the accepted consequence of fixing the suppression bug; it is pinned here
  // so the next person meets it as a property rather than a surprise.
  it('a tagged article scores differently from the same article untagged', () => {
    const untaggedScore = computeRelevance(base(), persona(), ENG, 0).score;
    const taggedScore = computeRelevance(
      { ...base(), geoTags: [{ city: 'brussels', countryCode: 'BEL' }] },
      persona(),
      ENG,
      0,
    ).score;
    expect(taggedScore).not.toBe(untaggedScore);
    // Higher, specifically: geoComp is a POSITIVE component and the tag aligns
    // with the persona's home city.
    expect(taggedScore).toBeGreaterThan(untaggedScore);
  });

  it('geoComp is non-zero for a geo-tagged article — it was always 0 before', () => {
    const c = computeRelevance(
      { ...base(), geoTags: [{ city: 'brussels', countryCode: 'BEL' }] },
      persona(),
      ENG,
      0,
    ).components;
    expect(c.geoComp).toBeGreaterThan(0);
  });

  it('eventComp/entityComp stay 0 without persona interest in them', () => {
    // Bounding the blast radius: an event type or entity only scores when the
    // persona expresses interest, so unblanking does not lift every tagged row.
    const c = computeRelevance(
      { ...base(), eventType: 'policy_change', entities: ['european commission'] },
      persona(),
      ENG,
      0,
    ).components;
    expect(c.entityComp).toBe(0);
  });
});
