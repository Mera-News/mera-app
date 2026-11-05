// news-harness — the daily sweep's AI check: does this saved fact touch the
// reader's life? PURE, RN-free. Volume alone cannot tell a stake from a flood.
//
// The rule is the chat save's own sentence, read off its tool contract, so the
// two can never drift. A missing or malformed answer is a stake: the check only
// ever proposes, and no offer is the safe side.

import { isUsableSubject } from '../../mera-harness/core/stake-handover';
import { SAVE_FACTS_TOOL, SAVE_INTEREST_FACTS_TOOL } from '../../mera-harness/core/tool-contracts';

const SAVE_INTEREST = SAVE_INTEREST_FACTS_TOOL.function;

/** What the interest save adds to the plain save's description. */
export const STAKE_RULE = SAVE_INTEREST.description.slice(SAVE_FACTS_TOOL.function.description.length).trim();

const SUBJECT_RULE = (
  SAVE_INTEREST.parameters.properties.extracted_user_information as {
    items: { properties: { story_subject: { description: string } } };
  }
).items.properties.story_subject.description;

/** Sent once per candidate, on the shared small model with thinking off. */
export const STAKE_CHECK_CALL = { maxTokens: 120, temperature: 0 } as const;

export function stakeCheckRequest(statement: string): { systemPrompt: string; prompt: string } {
  return {
    systemPrompt:
      'You read one fact saved about a reader of a news app. The fact is written about them, so "they said" means the fact says. '
      + `${STAKE_RULE}\n`
      + 'Being a fan is liking it: "Supports Ajax", "Follows PSV", "Fan of Manchester United" and "Interested in cryptocurrency" are false. '
      + 'A job, studies, a home, an illness, a relative, a trip or money they hold is always true: "Is a nurse", "Has asthma", "Sister lives in Pune" and "Owns a house in Porto" are true.\n'
      + `story_subject: ${SUBJECT_RULE} Taken from the fact, never made up.\n`
      + 'search: the same subject in English, as a news search.\n'
      + 'Answer with JSON only: {"has_stake":true or false,"story_subject":"...","search":"..."}',
    prompt: `Fact: ${JSON.stringify(statement)}`,
  };
}

export interface StakeCheck {
  hasStake: boolean;
  /** Null when the answer holds no usable subject: a personal phrase never
   *  reaches a follow topic. */
  subject: string | null;
  search: string | null;
}

const STAKE: StakeCheck = { hasStake: true, subject: null, search: null };

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Facts are stored in English, so a subject shares a word with its fact. The
 *  model handing the fact back whole is a phrase about the reader, and one
 *  sharing nothing is made up: it once answered "Formula 1" for a nurse. */
function usable(value: unknown, statement: string): value is string {
  if (!isUsableSubject(value, statement)) return false;
  if (value.trim().toLowerCase() === statement.trim().toLowerCase()) return false;
  const said = new Set(wordsOf(statement));
  return wordsOf(value).some((w) => said.has(w));
}

/** A topic is often lower case; a story's name on screen is not. */
export const capitalised = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

export function decodeStakeCheck(raw: string, statement: string): StakeCheck {
  const match = (raw ?? '').match(/\{[\s\S]*\}/);
  if (!match) return STAKE;
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return STAKE;
  }
  if (answer?.has_stake !== false) return STAKE;
  const subject = usable(answer.story_subject, statement) ? capitalised(answer.story_subject.trim()) : null;
  const search = isUsableSubject(answer.search, statement) ? answer.search.trim() : subject;
  return { hasStake: false, subject, search };
}
