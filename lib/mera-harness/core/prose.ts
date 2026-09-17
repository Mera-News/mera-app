// mera-harness/core — deterministic cleanup of MODEL-WRITTEN prose. PURE.
//
// WHY A DECODER AND NOT JUST THE PROMPT. Invariant 7 bans em and en dashes in
// user-facing copy, and the router prompt says so. Measured on the agent
// corpus, 25% of prose rows carried one anyway. A prompt rule is advice the
// model can decline; this is not. Same reasoning, and the same rule, as the
// scoring decoder applies to the feed's reason strings.
//
// DUPLICATED ON PURPOSE, and worth stating so nobody "fixes" it: the identical
// rule lives in `lib/news-harness/article-pipeline/scoring.ts`, where it is a
// private function in another area's file. This folder imports nothing from
// news-harness by design (see __tests__/boundary.test.ts), so the choice is a
// second copy or a broken boundary. If one changes, change both; the three
// cases below are the contract.

/**
 * Dash characters used as clause punctuation: em dash, en dash, horizontal bar.
 * Hyphen-minus is deliberately absent: it is a real word joiner ("on-device",
 * "Nieuw-West") and replacing it would corrupt prose and place names alike.
 */
const CLAUSE_DASHES = /(\s*)([—–―])(\s*)/g;

/**
 * Replace clause dashes with a comma. Three cases are NOT clause punctuation:
 *  - between digits it is a RANGE ("2014-2016", "10-15%"), left exactly as it
 *    was, whitespace included;
 *  - leading or trailing there is no second clause to join, so a comma would be
 *    worse than nothing, and it is dropped.
 *
 * Never concatenates: "a—b" becomes "a, b", never "ab".
 */
export function replaceClauseDashes(text: string): string {
  return text.replace(
    CLAUSE_DASHES,
    (match: string, _pre: string, _dash: string, _post: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      if (/\d$/.test(before) && /^\d/.test(after)) return match;
      if (before.trim().length === 0) return '';
      if (after.trim().length === 0) return '';
      return ', ';
    },
  );
}

/**
 * Everything applied to a prose string before a user reads it.
 *
 * Applied to BOTH the acknowledgement and the final reply, because the
 * acknowledgement is the first thing on screen and is exactly where the
 * measured dashes appeared ("confused by the statement — you said...").
 *
 * The whitespace collapse runs AFTER the dash pass on purpose: ", " emitted
 * where the model already had spaces around the dash would otherwise leave a
 * double space, and the collapse cleans it up for free.
 */
export function cleanProse(text: string): string {
  if (!text) return text;
  return replaceClauseDashes(text).replace(/[ \t]{2,}/g, ' ').trim();
}
