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
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/prompts';

describe('DEFAULT_HARNESS_CONFIG.articlePipeline', () => {
  const a = DEFAULT_HARNESS_CONFIG.articlePipeline;

  it('pins the scoring literals', () => {
    expect(a.articlesPerScorePrompt).toBe(5);
    expect(a.scoreBatchMaxTokens).toBe(80);
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
});

describe('DEFAULT_HARNESS_CONFIG.topicGen', () => {
  const t = DEFAULT_HARNESS_CONFIG.topicGen;

  it('pins the topic-gen literals', () => {
    expect(t.totalCloud).toBe(16);
    expect(t.totalLocal).toBe(14);
    expect(t.temperature).toBe(0.3);
    expect(t.maxFactLength).toBe(200);
  });

  it('wires the cloud topic-gen prompts', () => {
    expect(t.factOnlySystemPrompt).toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(t.comboSystemPrompt).toBe(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT);
  });
});

describe('HarnessConfig shape', () => {
  it('exposes both sub-configs', () => {
    const cfg: HarnessConfig = DEFAULT_HARNESS_CONFIG;
    expect(cfg.articlePipeline).toBeDefined();
    expect(cfg.topicGen).toBeDefined();
  });
});
