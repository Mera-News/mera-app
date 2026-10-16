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

/** A reply checked with `replyScript` passes at or above this share. 0.6, not
 *  0.9: Latin brand and unit words ("Mera", "MB", "Mera Protocol") are correct
 *  in a Hindi sentence and take a real bite out of a short one, while an
 *  English reply scores near 0, so nothing sits near the line by accident. */
export const REPLY_SCRIPT_MIN_SHARE = 0.6;

const SCRIPT_LETTER: Record<'devanagari', RegExp> = {
  devanagari: /\p{Script=Devanagari}/u,
};

/**
 * Share of LETTERS (`\p{L}`) written in `script`. Combining marks (`\p{M}`,
 * the Devanagari matras and virama) are not letters, so they count on neither
 * side; digits and punctuation are ignored. Null when the text has no letters
 * at all, which is a reply nobody can call Hindi or English.
 */
export function scriptShare(text: string, script: 'devanagari'): number | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return null;
  const re = SCRIPT_LETTER[script];
  return letters.filter((c) => re.test(c)).length / letters.length;
}
