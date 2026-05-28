// Decoy Generation Service — entity-swap pass over a fact's real topics.
//
// The Mera-Protocol noise layer used to ask the LLM to invent decoy topics
// from scratch. That produced asymmetric output (different vocabulary, length,
// volume, combo-shape than the real side), which leaked the user via shape
// alone. This service replaces that with a deterministic substitution: given
// the user's Fact and the real topics already generated for it, identify
// every concrete entity that appears and rewrite each topic with a
// parallel-shape unrelated replacement applied consistently. Output is
// shape-matched to the input by construction — same length, same vocabulary
// shell, same combo structure — so volume/format symmetry comes for free.
//
// One LLM call per fact, run AFTER the real topics are known. Caller
// (topic-generation-service) batches all facts' swap calls together so the
// extra round trip is still a single network hop per submit-facts.

import { cloudComplete } from '../llm/cloudComplete';
import { completeLocal } from '../llm/completeLocal';
import logger from '../logger';
import {
  LOCAL_NOISE_GENERATION_SYSTEM_PROMPT,
  NOISE_GENERATION_SYSTEM_PROMPT,
  sanitizeForPrompt,
} from './prompts';

export interface EntitySwapInputs {
  factStatement: string;
  /** The real topics that came out of the fact-only + combo prompts for this
   *  fact. The swap pass walks each one and rewrites entities. */
  realTopics: string[];
  /** True → cloud single-call. False → on-device. */
  useCloud: boolean;
}

export interface EntitySwapResult {
  /** The user's Fact with each entity swapped. Persisted to
   *  `noisy_user_topics.parent_topic_text` so the persona-tab debug switch
   *  can show what fake user each batch's noise belongs to. */
  decoyFact: string | null;
  /** Decoy topics — same count as input, same i-to-i correspondence. */
  topics: string[];
}

/** Pick the swap system prompt for the inference path. */
export function swapSystemPromptFor(useCloud: boolean): string {
  return useCloud ? NOISE_GENERATION_SYSTEM_PROMPT : LOCAL_NOISE_GENERATION_SYSTEM_PROMPT;
}

/** Build the user-prompt body for an entity-swap call. */
export function buildSwapUserPrompt(inputs: Omit<EntitySwapInputs, 'useCloud'>): string {
  return `Fact: "${sanitizeForPrompt(inputs.factStatement)}"
Topics: ${JSON.stringify(inputs.realTopics)}`;
}

/** Token budget for a swap call: ~70 base + ~14 per input topic. */
export function swapMaxTokensFor(topicCount: number): number {
  return Math.min(1024, 120 + topicCount * 14);
}

/**
 * Standalone entity-swap — used by the on-device sequential path. Never
 * throws (empty result on failure). The cloud batch path inlines its own
 * BatchCall instead, but shares this parser via `parseSwapOutput`.
 */
export async function swapEntitiesForFact(
  inputs: EntitySwapInputs,
): Promise<EntitySwapResult> {
  if (inputs.realTopics.length === 0) return { decoyFact: null, topics: [] };
  const prompt = buildSwapUserPrompt(inputs);

  try {
    const complete = inputs.useCloud ? cloudComplete : completeLocal;
    const output = await complete({
      systemPrompt: swapSystemPromptFor(inputs.useCloud),
      prompt,
      temperature: 0.3,
      maxTokens: swapMaxTokensFor(inputs.realTopics.length),
      ...(inputs.useCloud ? {} : { responseFormat: 'json' as const }),
    });
    return parseSwapOutput(output, inputs.realTopics.length);
  } catch (err) {
    logger.warn('[entity-swap] swap failed', {
      error: err instanceof Error ? err.message : String(err),
      factPreview: inputs.factStatement.slice(0, 80),
      count: inputs.realTopics.length,
    });
    return { decoyFact: null, topics: [] };
  }
}

/**
 * Parse + dedupe an entity-swap response. Expected shape:
 *   { "decoy_fact": "...", "decoy_topics": ["...", "..."] }
 * Tolerates legacy `topics` key (matches the old noise prompt's shape) so we
 * don't break mid-flight if a model picks the wrong key name.
 */
export function parseSwapOutput(output: string, expectedCount: number): EntitySwapResult {
  const parsed = parseJson(output);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const decoyFact =
      typeof obj.decoy_fact === 'string' && obj.decoy_fact.trim().length > 0
        ? obj.decoy_fact.trim()
        : null;
    const rawTopics = Array.isArray(obj.decoy_topics)
      ? obj.decoy_topics
      : Array.isArray(obj.topics)
        ? obj.topics
        : [];
    return { decoyFact, topics: dedupeTrim(rawTopics, expectedCount) };
  }

  if (Array.isArray(parsed)) {
    return { decoyFact: null, topics: dedupeTrim(parsed, expectedCount) };
  }

  const arrayMatch = output.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    try {
      const extracted = JSON.parse(arrayMatch[0]);
      if (Array.isArray(extracted)) {
        return { decoyFact: null, topics: dedupeTrim(extracted, expectedCount) };
      }
    } catch {
      // fall through
    }
  }
  return { decoyFact: null, topics: [] };
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function dedupeTrim(candidates: unknown[], maxCount: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const trimmed = c.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxCount) break;
  }
  return out;
}
