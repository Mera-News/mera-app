// Topic Generation Service — on-device topic generation for a single fact.
//
// One structured call per fact through the on-device text engine, with the
// on-device prompt and schema (lib/news-harness/on-device/topic-gen). Fact
// only: on-device has no combination pass (owner decision), so the topic_gen
// handler sends no other facts and none are read here. Cloud topics come from
// the skill core (topic-gen-handler → lib/mera-harness).

import logger from '../logger';
import { completeLocalStructured } from '../llm/completeLocal';
import { isOnDeviceDeferrable } from '../inference/job-defer';
import type { RealTopicGenInputs } from '@/lib/news-harness/persona-management/topic-generation';
import { buildTopicGenPrompt, TOPIC_GEN_SYSTEM } from '@/lib/news-harness/on-device/topic-gen/prompt';
import { promptBudgetTokens } from '@/lib/news-harness/on-device/shared';
import { contextSize, getTextEngine } from '../mera-protocol-toolkit';
import { topicGenSchema, type TopicGenReply } from '@/lib/news-harness/on-device/topic-gen/schema';
import { topicsFromReply } from '@/lib/news-harness/on-device/topic-gen/parse';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';

// Re-export moved pure helpers (canonical home is the harness).
export { mergeTopicsAppend } from '@/lib/news-harness/persona-management/topic-generation';
export type { RealTopicGenInputs };

// SOURCED from the harness config, never re-stated: this is what "Generate more
// topics" calls, and `topicPlan.generateMoreTopicsWarning` promises the user
// the same number.
const DEFAULT_TOTAL_LOCAL = DEFAULT_HARNESS_CONFIG.topicGen.totalLocal;

/**
 * Output budget for the on-device call (1024 = the on-device max-output
 * ceiling). Thinking is off, so the ~55-100 token answer is the whole cost;
 * larger counts raise it at 30 tokens a topic.
 */
const LOCAL_TOPIC_GEN_MAX_TOKENS = 1024;

/**
 * Topics for ONE fact on the on-device engine, used by the topic_gen handler's
 * local branch. Busy or unavailable is "not now" and reaches the queue so the
 * job defers; any other failure (including a reply that never fit the schema)
 * is an empty answer, which the handler reports as the fact's failure.
 */
export async function generateTopicsForFact(inputs: RealTopicGenInputs): Promise<string[]> {
  const count = inputs.totalCount ?? DEFAULT_TOTAL_LOCAL;
  const schema = topicGenSchema(count);
  const maxTokens = Math.max(LOCAL_TOPIC_GEN_MAX_TOKENS, count * 30);
  try {
    // Sized to the engine's input: Gemini Nano refuses an oversized prompt, and
    // that refusal is not deferrable, so a long exclusion list would fail the
    // fact on every retry.
    const engine = await getTextEngine();
    const budget = promptBudgetTokens({
      contextSize: await contextSize(engine),
      maxTokens,
      system: TOPIC_GEN_SYSTEM,
      schemaJson: JSON.stringify(schema),
    });
    const { system, prompt } = buildTopicGenPrompt(inputs, count, budget);
    const reply = await completeLocalStructured<TopicGenReply>({
      systemPrompt: system,
      prompt,
      schema,
      maxTokens,
      temperature: 0.3,
      engine,
    });
    return topicsFromReply(reply);
  } catch (err) {
    if (isOnDeviceDeferrable(err)) throw err;
    logger.warn('[topic-gen] local generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
