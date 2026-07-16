// Topic Generation Service — Real-topic generation for a single fact.
// Two sub-prompts per fact: fact-only + combo (when other facts exist).
// Cloud: parallel batch. On-device: sequential calls.
//
// The pure builders (buildBaseUserPrompt, splitCount, buildCloudBatchCallsForFact,
// mergeRealOutputsForFact, mergeTopicsAppend, parseTopicsFromOutput) moved to
// lib/news-harness/persona-management/topic-generation.ts. This module keeps the
// end-to-end single-fact generators (which drive the cloud/local LLM directly)
// and re-exports the moved builders — injecting the app logger and the (test-
// mockable) prompt constants at the seam so behaviour is unchanged.

import logger from '../logger';
import {
  cloudBatchComplete,
  type BatchCompletionResult,
} from '../llm/cloudComplete';
import type { BatchCall } from '../llm/types';
import { completeLocal } from '../llm/completeLocal';
import {
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
  sanitizeForPrompt,
} from './prompts';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import {
  buildBaseUserPrompt,
  splitCount,
  buildCloudBatchCallsForFact as harnessBuildCloudBatchCallsForFact,
  mergeRealOutputsForFact as harnessMergeRealOutputsForFact,
  parseTopicsFromOutput as harnessParseTopicsFromOutput,
  type RealTopicGenInputs,
} from '@/lib/news-harness/persona-management/topic-generation';

// Re-export moved pure helpers (canonical home is the harness).
export { buildBaseUserPrompt, splitCount, mergeTopicsAppend } from '@/lib/news-harness/persona-management/topic-generation';
export type { RealTopicGenInputs };

const DEFAULT_TOTAL_CLOUD = 16;
const DEFAULT_TOTAL_LOCAL = 14;

/**
 * Merge the raw factOnly + combo outputs for a single fact into a deduped
 * real-topic list. Wrapper over the harness helper that routes warnings through
 * the app logger.
 */
export function mergeRealOutputsForFact(
  factOnlyOutput: string | null,
  comboOutput: string | null,
  factStatement: string,
): string[] {
  return harnessMergeRealOutputsForFact(
    factOnlyOutput,
    comboOutput,
    factStatement,
    appHarnessLogger,
  );
}

export function parseTopicsFromOutput(output: string, factStatement: string): string[] {
  return harnessParseTopicsFromOutput(output, factStatement, appHarnessLogger);
}

/**
 * Build the up-to-2 real BatchCall entries for one fact: factOnly (always) +
 * combo (when other facts exist). Wrapper over the harness builder that injects
 * the cloud topic-gen system prompts.
 */
export function buildCloudBatchCallsForFact(
  inputs: Omit<RealTopicGenInputs, 'useCloud'>,
  idPrefix: string,
): BatchCall[] {
  return harnessBuildCloudBatchCallsForFact(inputs, idPrefix, {
    factOnly: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
    combo: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  });
}

/**
 * Generates topic strings from a single user fact, fact-only path.
 * Thin wrapper kept for non-handler callers that don't have user-location
 * or other-fact context.
 */
export async function generateTopicsFromFact(
  factStatement: string,
): Promise<string[]> {
  const output = await completeLocal({
    systemPrompt: LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
    prompt: `Fact: "${sanitizeForPrompt(factStatement)}"\nGenerate 14 topics.`,
    maxTokens: 400,
    temperature: 0.3,
    responseFormat: 'json',
    enableThinking: true,
  });
  return parseTopicsFromOutput(output, factStatement);
}

/**
 * End-to-end real topic generation for a SINGLE fact. Used by the single-
 * fact handler (topic-gen-handler). The multi-fact batch path in
 * tool-handlers uses the lower-level builders directly to share batches.
 *
 * Cloud → two parallel batch calls (factOnly + combo). Local → sequential.
 */
export async function generateTopicsForFact(
  inputs: RealTopicGenInputs,
): Promise<string[]> {
  const total =
    inputs.totalCount ?? (inputs.useCloud ? DEFAULT_TOTAL_CLOUD : DEFAULT_TOTAL_LOCAL);
  const hasOthers = inputs.otherFacts.length > 0;
  const { factOnly: factOnlyCount, combo: comboCount } = splitCount(total, hasOthers);

  let factOnlyOutput: string | null = null;
  let comboOutput: string | null = null;

  try {
    if (inputs.useCloud) {
      const calls: BatchCall[] = [];
      if (factOnlyCount > 0) {
        calls.push({
          id: 'factOnly',
          system: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
          prompt: `${buildBaseUserPrompt(inputs, false)}\nGenerate ${factOnlyCount} topics.`,
          temperature: 0.3,
          maxTokens: Math.max(400, factOnlyCount * 30),
        });
      }
      if (comboCount > 0 && hasOthers) {
        calls.push({
          id: 'combo',
          system: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
          prompt: `${buildBaseUserPrompt(inputs, true)}\nGenerate ${comboCount} topics.`,
          temperature: 0.3,
          maxTokens: Math.max(400, comboCount * 30),
        });
      }
      if (calls.length > 0) {
        const results = (await cloudBatchComplete(calls)) as BatchCompletionResult[];
        for (const r of results) {
          if (r.error) {
            logger.warn('[topic-gen] cloud half failed', { half: r.id, error: r.error });
            continue;
          }
          if (r.id === 'factOnly') factOnlyOutput = r.output;
          else if (r.id === 'combo') comboOutput = r.output;
        }
      }
    } else {
      if (factOnlyCount > 0) {
        try {
          factOnlyOutput = await completeLocal({
            systemPrompt: LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
            prompt: `${buildBaseUserPrompt(inputs, false)}\nGenerate ${factOnlyCount} topics.`,
            maxTokens: Math.max(400, factOnlyCount * 30),
            temperature: 0.3,
            responseFormat: 'json',
            enableThinking: true,
          });
        } catch (err) {
          logger.warn('[topic-gen] local factOnly failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (comboCount > 0 && hasOthers) {
        try {
          comboOutput = await completeLocal({
            systemPrompt: LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
            prompt: `${buildBaseUserPrompt(inputs, true)}\nGenerate ${comboCount} topics.`,
            maxTokens: Math.max(400, comboCount * 30),
            temperature: 0.3,
            responseFormat: 'json',
            enableThinking: true,
          });
        } catch (err) {
          logger.warn('[topic-gen] local combo failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    logger.warn('[topic-gen] real-stage failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return mergeRealOutputsForFact(factOnlyOutput, comboOutput, inputs.factStatement);
}

/** Back-compat alias used by generateTopicsFromFact (local-only path). */
export async function generateRealTopicsForFact(
  inputs: RealTopicGenInputs,
): Promise<string[]> {
  return generateTopicsForFact(inputs);
}
