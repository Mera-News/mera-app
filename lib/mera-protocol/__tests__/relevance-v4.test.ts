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
//   2. SUPPRESSION PARITY. `USE_ARTICLE_TAGS` — deliberately NOT part of v4 —
//      is the gate for routing AND for the structured `entity`/`place`/
//      `event_type` suppression kinds, in both the soft penalty and the hard
//      screen. If v4 had been wired to it (or if `tag-policy.ts` had been
//      deleted with the rest of v3), every user's "not interested" filter would
//      silently start matching different articles. These tests assert the
//      matched set is identical with the toggle on and off.

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
import { applyArticleTagPolicy } from '../../news-harness/scoring-engine/tag-policy';
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

  it('ON does not change routing — the tag block is prompt INPUT only', () => {
    // `isBackstop` keys off the same three fields the prompt block reads, but
    // through a different door: the ENGINE only ever sees what
    // `applyArticleTagPolicy` lets through, and v4 does not touch that policy.
    // So a v4-scored candidate is still a backstop candidate.
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
    const stripped = applyArticleTagPolicy(input, eng);
    expect(computeRelevance(stripped, persona, eng, Date.now()).mode).toBe('backstop');
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

describe('v4 does not move suppression — USE_ARTICLE_TAGS is not part of it', () => {
  const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

  /** A fully-tagged candidate — the case that could change behaviour, since the
   *  structured suppression kinds match on exactly these fields. */
  const taggedInput = (): ScoredCandidateInput => ({
    id: 'a0',
    titleEn: 'Commission opens antitrust case',
    descriptionEn: 'Brussels probe',
    matchedTopics: [],
    geoTags: [{ city: 'brussels', countryCode: 'BEL' }],
    entities: ['european commission'],
    eventType: 'crime',
  });

  const filters: SoftSuppression[] = [
    { keywords: [], strength: 1, kind: 'entity', value: 'european commission' },
    { keywords: [], strength: 1, kind: 'place', value: 'brussels' },
    { keywords: [], strength: 1, kind: 'event_type', value: 'crime' },
    { keywords: ['antitrust'], strength: 1 },
  ];

  /** What the ENGINE actually sees — the seam `buildStageCandidates` applies. */
  const asEngineSees = () => applyArticleTagPolicy(taggedInput(), ENG);

  it('the tag policy still strips the three fields, so no structured kind can match', () => {
    const seen = asEngineSees();
    expect(seen.geoTags).toEqual([]);
    expect(seen.entities).toEqual([]);
    expect(seen.eventType).toBeNull();

    for (const f of filters.slice(0, 3)) {
      expect(suppressionMatchesCandidate(seen, f)).toBe(false);
    }
    // …and the plain keyword filter, which reads title/description, is
    // unaffected: turning tags off must not turn "not interested" off.
    expect(suppressionMatchesCandidate(seen, filters[3])).toBe(true);
  });

  it('the keyword haystack does not gain the entities', () => {
    expect(buildSuppressionHaystack(asEngineSees())).not.toContain(
      'european commission',
    );
  });

  it('the HARD screen drops exactly the same row set', () => {
    // The hard screen runs on the v1 path via `computeMathStage`, so this is the
    // live behaviour, not a hypothetical.
    const dropped = screenHardSuppressions([asEngineSees()], filters);
    // Only the keyword filter matches — the three structured ones cannot.
    expect([...dropped.keys()]).toEqual(['a0']);

    const noKeyword = filters.slice(0, 3);
    expect(screenHardSuppressions([asEngineSees()], noKeyword).size).toBe(0);
  });

  it('the SOFT penalty comes from the ONE keyword filter and nothing else', () => {
    // Pinned as a VALUE, not as "on equals off" — the latter is circular here,
    // since `computeRelevance` takes the `scoringEngine` slice and v4 lives
    // entirely in `articlePipeline`, so it could not differ. What is worth
    // pinning is the SIZE of the penalty: exactly one of these four filters can
    // match a tag-stripped candidate. If the three structured ones ever started
    // matching (the failure mode deleting `tag-policy.ts` would cause), this
    // number would rise and the test would say so.
    const persona: PersonaScoringContext = {
      locations: [],
      pubPrefs: new Map(),
      softSuppressions: filters.map((f) => ({ ...f, strength: 0.5 })),
      hardSuppressions: [],
    };
    const { suppressPenalty } = computeRelevance(
      asEngineSees(),
      persona,
      ENG,
      Date.now(),
    ).components;

    expect(suppressPenalty).toBeCloseTo(ENG.P_SUP * 0.5, 10);
  });
});
