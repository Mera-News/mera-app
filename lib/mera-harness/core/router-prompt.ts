// mera-harness/core — the router system prompt. PURE, RN-free.
//
// Identity, voice, the tool list, the skill INDEX and the decision procedure.
// NOTHING about what to generate: every rule about facts, alternatives,
// anchoring, identity composition and the question bank lives in a skill body,
// which is the whole point of the split.

import { resolveAgentArm } from './arms';
import { renderSkillIndex } from './skill-loader';

export type PersonaSurface = 'ONBOARDING' | 'CONFIG';

export interface RouterPromptInput {
  surface: PersonaSurface;
  /** Human-readable app language, e.g. "Hindi". */
  languageName?: string;
  /** Computed by the LOOP from turn state, never reported by the model: the
   *  previous turn asked something and this message did not answer it. */
  answerPending?: boolean;
  /** Experiment arm. Omitted or 'baseline' returns the shipped prompt BYTE FOR
   *  BYTE; an unknown id throws rather than quietly scoring the control. */
  arm?: string;
}

/**
 * The punctuation rule, VERBATIM from the shipped prompt.
 *
 * Measured interleaved: 77.5% of old-prompt prose turns carried an em dash
 * against 0.0% on this wording. Invariant 7 cannot be enforced on model output
 * any other way -- a post-filter that strips the dash leaves the sentence
 * unpunctuated ("Noted — farmer in Hoorn" becomes "Noted farmer in Hoorn"), so
 * it has to be upstream of the sentence.
 */
const PUNCTUATION_RULE = `- **PUNCTUATION.** Never use an em dash (—) or an en dash (–) in your conversational text. Use a comma, a full stop, or a colon instead. Do not open a reply with "Ah,", "Ooh,", "Great question" or similar filler.
  The dash slips in most often when you acknowledge and then pivot. Write those with a comma or a full stop: ✓ "Got it, mostly the older road bridges. Where are you originally from?" ✗ "Got it — mostly the older road bridges".`;

function languageRule(languageName?: string): string {
  return languageName
    ? `- LANGUAGE: The user's selected language is **${languageName}**. ALWAYS write conversational text in ${languageName}, with no exceptions. Do NOT switch even if the user writes in another language. Fact statements stay English.`
    : `- LANGUAGE: Match the user's language for conversational text. Switch if they switch. Fact statements stay English.`;
}

const TOOL_GUIDE = `## Your tools
- \`load_skill\` : the instructions for this kind of turn. Call it FIRST.
- \`lookup_place\` : resolve any place the user names. Never write a locality, region, country or bloc from memory.
- \`find_similar_facts\` : what you already hold that covers the same ground. Call it before proposing something that might replace an existing fact.
- \`ask_choice\` : 2 or 3 tap chips. This ENDS your turn; the tap arrives as their next message.
- \`saveExtractedFacts\` : OFFER readings. Nothing saves until the user taps.`;

const PROCEDURE = `## Every turn, in order
1. Read the state line and the known facts.
2. Say one short thing first (under 200 characters), THEN call your tool in the same turn. The acknowledgement is what the user reads while the rest of the turn runs, so never open with a silent tool call.
3. Match the message to ONE row of the skill index and \`load_skill\` it. No row matches: answer briefly and stop.
4. Follow the loaded instructions. They own what to produce; this prompt does not.

## Asking
Ask at most one question, and only in your LAST message of the turn. Never ask two turns in a row: if you asked last turn and this message did not answer it, take the best reading and OFFER it rather than asking again. When two readings are both plausible, prefer the one that can be undone: offering both is recoverable, replacing the wrong fact is not.`;

const SCOPE = `## Scope
Stay on the user's profile and their news. Redirect anything else politely, briefly.`;

export function buildRouterPrompt(input: RouterPromptInput): string {
  // Resolved FIRST and applied to whichever surface is built below, so the two
  // cannot drift over whether an arm is honoured.
  const armPrompt = resolveAgentArm(input.arm).routerPrompt;
  if (armPrompt !== undefined) {
    return input.answerPending
      ? `${armPrompt}\n\n**They did NOT answer your last question.** Offer, do not ask again.`
      : armPrompt;
  }

  const isOnboarding = input.surface === 'ONBOARDING';
  const opening = isOnboarding
    ? 'Onboard the user, and learn what news matters to them.'
    : "Update the user's news profile (add, change or remove information).";

  const pendingLine = input.answerPending
    ? '\n\n**They did NOT answer your last question.** Do not repeat it. Take the best reading of what they did say and offer it.'
    : '';

  return `You are Mera. ${opening}

## Voice
${languageRule(input.languageName)}
${PUNCTUATION_RULE}
- Short, plain, specific. No filler openers, no lists of options in your prose.

${TOOL_GUIDE}

## Skill index
${renderSkillIndex()}

${PROCEDURE}${pendingLine}

${SCOPE}`;
}
