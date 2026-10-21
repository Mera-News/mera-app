// D39: when Kev is unsure, Mera asks with the existing ask_choice chips instead
// of acting. Pure and RN-free.
//
// Contract for the flows and the card (P6b):
// - The agent records a tool call `ask_choice` with the input from
//   buildAskChoice and the result ASK_CHOICE_AWAITING. deriveThreadItems shows
//   chips only for a result with `awaiting: 'user'`, and only the first 3
//   options.
// - "Something else" is NOT an option. The input carries `somethingElse: true`,
//   and AskChoiceCard appends its own localised chip that focuses the composer
//   and sends nothing. As an option its text would be sent as a user message,
//   and cloud ask cards (which never set the flag) must not change.
// - A chip tap sends the label verbatim. readingFromTap maps it back to the
//   reading key, so the next turn acts on it without asking Kev again.
// - Labels: plain user-facing text, already localised by the flow. A label
//   that starts with "You" or "I" makes the card read the list as distinct
//   facts (isFactPickChoice) and add a "Save all" chip. Choice keys that look
//   like numbers sort first in Kev's criteria: prefix them ('f1').

import type { DecisionChoiceAnswer } from 'llama.rn';
import { ranked } from './decision';

export const ASK_CHOICE_TOOL = 'ask_choice';
/** The tool result that makes the chips show. */
export const ASK_CHOICE_AWAITING = { awaiting: 'user' } as const;

const MAX_LABEL_CHARS = 60;
const MAX_READINGS = 3;
/** ponytail: a fixed floor for the third chip; tune on the harness's ask rate if three chips read as noise. */
const THIRD_READING_MIN_P = 0.1;

export interface AskChoiceInput {
  question: string;
  options: string[];
  /** The card adds its own "Something else" chip, which focuses the composer. */
  somethingElse: true;
}

/** At most 60 characters, cut at a word boundary when there is one. */
export function clipLabel(label: string): string {
  const text = label.trim().replace(/\s+/g, ' ');
  const chars = Array.from(text);
  if (chars.length <= MAX_LABEL_CHARS) return text;
  const head = chars.slice(0, MAX_LABEL_CHARS).join('');
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, '');
}

/**
 * The 2-3 likeliest readings as chips, or null when fewer than 2 remain (the
 * card shows nothing below 2; the flow then acts on its top reading or replies).
 * A reading with no label in `labels` is never offered, and two readings with
 * the same label make one chip. The third chip needs p >= 0.1.
 */
export function buildAskChoice<K extends string>(
  answer: Pick<DecisionChoiceAnswer<K>, 'probabilities'> & { choice?: K },
  labels: Partial<Record<NoInfer<K>, string>>,
  question: string,
): AskChoiceInput | null {
  const options: string[] = [];
  for (const { key, p } of ranked(answer, Object.keys(labels))) {
    if (options.length === MAX_READINGS) break;
    if (options.length === 2 && p < THIRD_READING_MIN_P) break;
    const raw = labels[key];
    if (!raw) continue;
    const label = clipLabel(raw);
    if (label && !options.includes(label)) options.push(label);
  }
  return options.length >= 2 ? { question: question.trim(), options, somethingElse: true } : null;
}

/** The reading a chip tap chose: the key whose label the message is, ignoring case and spacing. */
export function readingFromTap<K extends string>(message: string, labels: Partial<Record<K, string>>): K | null {
  const said = clipLabel(message ?? '').toLowerCase();
  if (!said) return null;
  for (const key of Object.keys(labels) as K[]) {
    const label = labels[key];
    if (label && clipLabel(label).toLowerCase() === said) return key;
  }
  return null;
}
