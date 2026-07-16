// news-harness — configuration.
//
// The literals below are the EXACT current production values, previously spread
// as module constants across scoring-service.ts, inference-results.ts,
// topic-generation-service.ts, tool-handlers.ts, and feed-sync-steps.ts. They
// are gathered here so the harness has a single injectable config surface while
// behaviour stays bit-identical. See config.test.ts, which pins every literal.

import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/prompts';

/** SMALL_MODEL literal — mirrored from lib/llm/constants.ts (kept out of the
 *  harness import graph on purpose so the harness stays RN-free). */
const SMALL_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';

export interface ArticlePipelineConfig {
  /** Articles bundled into one batched relevance prompt (cloud). */
  articlesPerScorePrompt: number;
  /** Output token ceiling for one batched score call. */
  scoreBatchMaxTokens: number;
  /** Sampling temperature for relevance-score calls. */
  scoreTemperature: number;
  /** Sampling temperature for reason-generation calls. */
  reasonTemperature: number;
  /** Output token ceiling for one reason call. */
  reasonMaxTokens: number;
  /** Raw scores below this stay raw (not bucketed) — the DISCARD floor. */
  discardFloor: number;
  /** Fallback relevance when LLM scoring fails or output is unparseable. */
  fallbackRelevance: number;
  /** Default relevance for candidates ineligible for scoring (no body/facts). */
  ineligibleRelevance: number;
  /** Bucketed-relevance floor that gates phase-2 reason generation. */
  reasonRelevanceThreshold: number;
  // --- Bucket cutoffs (raw LLM score) + persisted representative values ---
  mediumPriorityCutoff: number;
  highPriorityCutoff: number;
  /** Strictly greater than this → EMERGENCY. */
  emergencyPriorityCutoff: number;
  lowPriorityScore: number;
  mediumPriorityScore: number;
  highPriorityScore: number;
  emergencyPriorityScore: number;
  /** Per-topic article-id fetch cap (feed-sync). */
  limitPerTopic: number;
  /** Chunk size when hydrating full article records (feed-sync). */
  hydrateChunkSize: number;
  /** System prompt for the cloud relevance pass. */
  relevanceSystemPrompt: string;
  /** System prompt for the cloud reason pass. */
  reasonSystemPrompt: string;
  /** Cloud model used for scoring + reason generation. */
  model: string;
}

export interface TopicGenConfig {
  /** Default total topics per fact in cloud mode. */
  totalCloud: number;
  /** Default total topics per fact in on-device mode. */
  totalLocal: number;
  /** Sampling temperature for topic generation. */
  temperature: number;
  /** Maximum accepted fact statement length. */
  maxFactLength: number;
  /** System prompt for the fact-only topic-generation call. */
  factOnlySystemPrompt: string;
  /** System prompt for the fact+others combo topic-generation call. */
  comboSystemPrompt: string;
}

export interface HarnessConfig {
  articlePipeline: ArticlePipelineConfig;
  topicGen: TopicGenConfig;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  articlePipeline: {
    articlesPerScorePrompt: 5,
    scoreBatchMaxTokens: 80,
    scoreTemperature: 0.1,
    reasonTemperature: 0.2,
    reasonMaxTokens: 64,
    discardFloor: 0.4,
    fallbackRelevance: 0.3,
    ineligibleRelevance: 0.2,
    reasonRelevanceThreshold: 0.3,
    mediumPriorityCutoff: 0.6,
    highPriorityCutoff: 0.8,
    emergencyPriorityCutoff: 1.0,
    lowPriorityScore: 0.4,
    mediumPriorityScore: 0.6,
    highPriorityScore: 0.8,
    emergencyPriorityScore: 1.1,
    limitPerTopic: 20,
    hydrateChunkSize: 25,
    relevanceSystemPrompt: CLOUD_RELEVANCE_SYSTEM_PROMPT,
    reasonSystemPrompt: CLOUD_REASON_SYSTEM_PROMPT,
    model: SMALL_MODEL,
  },
  topicGen: {
    totalCloud: 16,
    totalLocal: 14,
    temperature: 0.3,
    maxFactLength: 200,
    factOnlySystemPrompt: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
    comboSystemPrompt: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  },
};
