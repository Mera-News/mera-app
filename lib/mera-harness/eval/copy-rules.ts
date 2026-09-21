// mera-harness/eval — the user-facing copy rules, in ONE place.
//
// Lifted verbatim out of harness-local/scripts/extraction-metrics.ts, which now
// imports from here. Two copies of a punctuation rule drift, and the en-dash
// subtlety below is exactly the kind that drifts: it took a measurement to get
// right and would be re-guessed wrong by whoever wrote the second copy.

/** The em dash is banned outright in user-facing copy. */
const EM_DASH = /—/;

/**
 * The en dash counts ONLY when used AS a dash, that is with a non-digit on at
 * least one side. "2019-2024" is a range and legitimate; "the plan - and then"
 * is the tell. Counting every en dash would score date ranges as violations and
 * make the rate useless on news text, which is full of them.
 */
const EN_DASH_AS_DASH = /(^|[^0-9])–|–([^0-9]|$)/;

export function hasBannedDash(text: string): boolean {
  return EM_DASH.test(text) || EN_DASH_AS_DASH.test(text);
}

/** Words in a topic. Topics are scored against a 2-to-5 word rule. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export const TOPIC_MIN_WORDS = 2;
export const TOPIC_MAX_WORDS = 5;

export function topicWordCountOk(topic: string): boolean {
  const n = wordCount(topic);
  return n >= TOPIC_MIN_WORDS && n <= TOPIC_MAX_WORDS;
}

/**
 * The assistant PROSE, which is what a user actually reads. A reasoning trace
 * and any tool-call payload are stripped first: a dash inside a think block or
 * inside JSON arguments never reaches the user, and counting it would blame a
 * prompt for a violation it did not produce.
 *
 * Rate a text violation over rows that HAVE text. A leg whose reply was only a
 * tool call has no prose, cannot violate a punctuation rule, and dilutes the
 * rate toward zero if counted — measured at 2 of 123 turns on one arm against
 * 3 of 123 on another, which was the whole apparent difference between them.
 */
export function proseOf(rawOutput: string): string {
  let text = rawOutput;
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const lastCloser = text.lastIndexOf('</think>');
  if (lastCloser !== -1) text = text.slice(lastCloser + '</think>'.length);
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/\{[\s\S]*?"extracted_user_information"[\s\S]*?\}\s*\}/g, '');
  return text.trim();
}
