// On-device topic generation from the fact alone (owner decision: on-device
// has no combination pass, so no other facts and no location line). Written for the phone's small models: no real-world
// examples, which a small model copies into its answer; a short system
// instruction (Gemini Nano wants it under ~150 words); the rules lead the user
// message so a prefix cache keeps them across facts.
import { buildBaseUserPrompt, type RealTopicGenInputs } from '../../persona-management/topic-generation';
import { countTokens, largestFitting } from '../shared';
import { DEVICE_SLOTS } from '../../../harnesses/slots';

export const TOPIC_GEN_SYSTEM = DEVICE_SLOTS["topic-gen/topic-gen-system"];

const TOPIC_GEN_RULES = DEVICE_SLOTS["topic-gen/topic-gen-rules"];

/**
 * The instruction and the message for one fact. `count` is the most topics to ask for.
 * `budgetTokens` (countTokens) bounds the message: the exclusion list is cut from its end until it
 * fits, so the caller puts the fact's own topics first. Cutting it is safe: the handler drops a
 * repeated or declined topic after the call anyway.
 */
export function buildTopicGenPrompt(
  inputs: Pick<RealTopicGenInputs, 'factStatement' | 'excludeTopics'>,
  count: number,
  budgetTokens = Infinity,
): { system: string; prompt: string } {
  // The fact alone: a location or other facts drawn from the rest of the
  // persona would be a combination.
  const exclude = inputs.excludeTopics ?? [];
  const build = (n: number) => {
    const facts = buildBaseUserPrompt(
      { factStatement: inputs.factStatement, excludeTopics: exclude.slice(0, n), userLocation: null, otherFacts: [] },
      false,
    );
    return `${TOPIC_GEN_RULES}\n\n${facts}\nGenerate ${count} topics.`;
  };
  const kept = largestFitting(exclude.length, (n) => countTokens(build(n)) <= budgetTokens);
  return { system: TOPIC_GEN_SYSTEM, prompt: build(kept) };
}
