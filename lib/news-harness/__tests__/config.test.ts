// Pins every DEFAULT_HARNESS_CONFIG literal to the historical production value.
// These are hardcoded expectations (NOT re-derived from the source) so an
// accidental drift in the harness config fails loudly.

import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
} from '../core/config';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/prompts';

describe('DEFAULT_HARNESS_CONFIG.articlePipeline', () => {
  const a = DEFAULT_HARNESS_CONFIG.articlePipeline;

  it('pins the scoring literals', () => {
    expect(a.articlesPerScorePrompt).toBe(5);
    // 80 → 320 with the tiered {"k","s"} relevance output (2026-07-16 prompt
    // rework, validated against the golden-labeled 1000-article prod run).
    expect(a.scoreBatchMaxTokens).toBe(320);
    expect(a.scoreTemperature).toBe(0.1);
    expect(a.reasonTemperature).toBe(0.2);
    expect(a.reasonMaxTokens).toBe(64);
  });

  it('pins the relevance floors', () => {
    expect(a.discardFloor).toBe(0.4);
    expect(a.fallbackRelevance).toBe(0.3);
    expect(a.ineligibleRelevance).toBe(0.2);
    expect(a.reasonRelevanceThreshold).toBe(0.3);
  });

  it('pins the bucket cutoffs and representative values', () => {
    expect(a.mediumPriorityCutoff).toBe(0.6);
    expect(a.highPriorityCutoff).toBe(0.8);
    expect(a.emergencyPriorityCutoff).toBe(1.0);
    expect(a.lowPriorityScore).toBe(0.4);
    expect(a.mediumPriorityScore).toBe(0.6);
    expect(a.highPriorityScore).toBe(0.8);
    expect(a.emergencyPriorityScore).toBe(1.1);
  });

  it('pins the feed-sync limits and model', () => {
    expect(a.limitPerTopic).toBe(20);
    expect(a.hydrateChunkSize).toBe(25);
    expect(a.model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });

  it('wires the cloud scoring prompts', () => {
    expect(a.relevanceSystemPrompt).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
    expect(a.reasonSystemPrompt).toBe(CLOUD_REASON_SYSTEM_PROMPT);
  });

  it('pins the second-pass FEED verifier config', () => {
    // 2026-07-16: adopted the validated second-pass FEED verifier ("Design A2 —
    // tuned"). Default ON. Demote score 0.28 is deliberately below the 0.3
    // reason/visibility cutoff and inside the TANGENTIAL band (0.25–0.39).
    // maxTokens 260 = batchSize(15)*12 + 80.
    expect(a.feedVerifierEnabled).toBe(true);
    expect(a.feedVerifierBatchSize).toBe(15);
    expect(a.feedVerifierDemoteScore).toBe(0.28);
    expect(a.feedVerifierMaxTokens).toBe(260);
    expect(a.feedVerifierSystemPrompt).toBe(CLOUD_FEED_VERIFIER_SYSTEM_PROMPT);
  });
});

describe('DEFAULT_HARNESS_CONFIG.topicGen', () => {
  const t = DEFAULT_HARNESS_CONFIG.topicGen;

  it('pins the topic-gen literals', () => {
    // 2026-07-16: reduced 16→10 / 14→10 (deliberate product change — see
    // config.ts comment; golden-labeled baseline showed worst 25% of topics
    // cuttable with 0% true-FEED loss).
    expect(t.totalCloud).toBe(10);
    expect(t.totalLocal).toBe(10);
    expect(t.temperature).toBe(0.3);
    expect(t.maxFactLength).toBe(200);
  });

  it('wires the cloud topic-gen prompts', () => {
    expect(t.factOnlySystemPrompt).toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(t.comboSystemPrompt).toBe(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT);
  });
});

describe('DEFAULT_HARNESS_CONFIG.scoringEngine', () => {
  const e = DEFAULT_HARNESS_CONFIG.scoringEngine;

  it('pins the affinity component weights (positives sum ≈ 1.0)', () => {
    expect(e.W_TOPIC).toBe(0.42);
    expect(e.W_GEO).toBe(0.2);
    expect(e.W_ENTITY).toBe(0.08);
    expect(e.W_EVENT).toBe(0.05);
    expect(e.W_PUB).toBe(0.07);
    expect(e.W_POP).toBe(0.1);
    expect(e.W_FRESH).toBe(0.08);
    const sum = e.W_TOPIC + e.W_GEO + e.W_ENTITY + e.W_EVENT + e.W_PUB + e.W_POP + e.W_FRESH;
    expect(Number(sum.toFixed(6))).toBe(1.0);
  });

  it('pins the affinity → raw band mapping', () => {
    expect(e.BASE_OFFSET).toBe(0.05);
    expect(e.BASE_SLOPE).toBe(1.05);
    expect(e.BASE_MIN).toBe(0.05);
    expect(e.BASE_MAX).toBe(1.1);
  });

  it('pins the penalties', () => {
    expect(e.P_NEG).toBe(0.45);
    expect(e.P_SUP).toBe(0.3);
    expect(e.P_SUP_CAP).toBe(0.6);
    expect(e.P_WRONG).toBe(0.55);
    expect(e.P_SEEN).toBe(0.08);
  });

  it('pins topic weighting, popularity + freshness knees', () => {
    expect(e.HP_MULT).toBe(1.25);
    expect(e.POP_SAT).toBe(32);
    expect(e.FRESH_FULL_HOURS).toBe(6);
    expect(e.FRESH_DECAY_HOURS).toBe(24);
    expect(e.FRESH_MID_SCORE).toBe(0.3);
    expect(e.FRESH_OLD_SCORE).toBe(0.1);
  });

  it('pins geo alignment multipliers + headline floor', () => {
    expect(e.GEO_CITY).toBe(1.0);
    expect(e.GEO_REGION).toBe(0.6);
    expect(e.GEO_COUNTRY).toBe(0.3);
    expect(e.HEADLINE_BASE_FLOOR).toBe(0.35);
    expect(e.HEADLINE_POP_LIFT).toBe(0.15);
  });
});

describe('HarnessConfig shape', () => {
  it('exposes all sub-configs', () => {
    const cfg: HarnessConfig = DEFAULT_HARNESS_CONFIG;
    expect(cfg.articlePipeline).toBeDefined();
    expect(cfg.topicGen).toBeDefined();
    expect(cfg.scoringEngine).toBeDefined();
  });
});
