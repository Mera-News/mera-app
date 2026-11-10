// On-device topic generation from the fact alone (owner decision: on-device
// has no combination pass, so no other facts and no location line). Written for the phone's small models: no real-world
// examples, which a small model copies into its answer; a short system
// instruction (Gemini Nano wants it under ~150 words); the rules lead the user
// message so a prefix cache keeps them across facts.
import { buildBaseUserPrompt, type RealTopicGenInputs } from '../../persona-management/topic-generation';
import { countTokens, largestFitting } from '../shared';
import { DEVICE_SLOTS } from '../../../harnesses/slots';
import { render } from '../../../harnesses/template';

export const TOPIC_GEN_SYSTEM = DEVICE_SLOTS["topic-gen/topic-gen-system"];

const TOPIC_GEN_RULES = DEVICE_SLOTS["topic-gen/topic-gen-rules"];

/** Where a fact points: the on-device stand-in for the cloud's topics/* guidelines. */
export type TopicFactKind = 'residence' | 'elsewhere' | 'origin' | 'field';

const ORIGIN = /\b(?:originally from|comes? from|is from|grew up in|born in|expat|emigrated|immigrant|diaspora|heritage)\b|^from\b/i;
const RELATIVE =
  /\b(?:parents?|mother|father|mum|mom|dad|brother|sister|siblings?|son|daughter|children|kids|partner|wife|husband|spouse|family|relatives?|grand\w*|uncle|aunt|cousin|friends?)\b/i;
const IN_A_PLACE = /\b(?:lives?|living|based|stays?|studies|studying|works?|working)\s+in\b/i;
const VISITING = /\bvisit(?:s|ing)?\b/i;
const HOME = /\b(?:lives?|living|based|resides?|moved|relocated)\s+(?:in|to)\b/i;
/** "Works in Amsterdam" is a place, "works in finance" a field: a statement cannot tell them apart. */
const WORK_IN_NAME = /\b(?:[Ww]orks?|[Ww]orking|[Ss]tudies|[Ss]tudying)\s+(?:in|at)\s+\p{Lu}/u;
const FIELD =
  /\b(?:works?|working|job|employed|profession|occupation|career|invest\w*|owns?|runs?|plays?|playing|listens?|watch(?:es|ing)?|supports?|fan|follows?|enjoys?|likes?|loves?|interested|reads?|collects?|hobby|hobbies)\b/i;

/**
 * The fact's kind from its statement (facts are written in English), or null when it is none of
 * these for sure. shortcut: read from the statement because the on-device job passes no attribute;
 * pass `questionnaireAttribute` through `topicSkillForAttribute` if a statement misreads.
 */
export function topicFactKind(statement: string): TopicFactKind | null {
  if (ORIGIN.test(statement)) return 'origin';
  if (RELATIVE.test(statement) && IN_A_PLACE.test(statement)) return 'elsewhere';
  if (VISITING.test(statement)) return 'elsewhere';
  if (HOME.test(statement)) return 'residence';
  if (WORK_IN_NAME.test(statement)) return null;
  if (FIELD.test(statement)) return 'field';
  return null;
}

/**
 * The rule block for one fact. AFM reads the whole block as one template, so a job or an interest
 * borrowed the place rules' subject list; it gets the field line alone. Every place kind keeps the
 * whole block: measured alone, the origin line drew refusals and the place lines dropped the
 * place's own name.
 */
function topicRules(statement: string): string {
  return render(TOPIC_GEN_RULES, { fieldOnly: topicFactKind(statement) === 'field' });
}

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
  const rules = topicRules(inputs.factStatement);
  const build = (n: number) => {
    const facts = buildBaseUserPrompt(
      { factStatement: inputs.factStatement, excludeTopics: exclude.slice(0, n), userLocation: null, otherFacts: [] },
      false,
    );
    return `${rules}\n\n${facts}\nGenerate ${count} topics.`;
  };
  const kept = largestFitting(exclude.length, (n) => countTokens(build(n)) <= budgetTokens);
  return { system: TOPIC_GEN_SYSTEM, prompt: build(kept) };
}
