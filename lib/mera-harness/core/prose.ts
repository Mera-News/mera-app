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

/**
 * The trailing question of a reply, or null.
 *
 * A reply is usually an acknowledgement plus a question ("Got it, Nieuw-West.
 * What do you do for work?"), and only the question is worth carrying into the
 * next turn: the acknowledgement is about the turn that just ended. Splits on
 * sentence ends and takes the last sentence, which must itself be a question.
 */
export function trailingQuestion(text: string): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.endsWith('?')) return null;
  // Split AFTER . ! ? so the question mark stays with its own sentence.
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const last = sentences[sentences.length - 1]?.trim() ?? '';
  return last.endsWith('?') ? last : null;
}

// ---------------------------------------------------------------------------
// Reply gate detectors.
//
// Both run on `cleanProse` OUTPUT, never on raw model text. Half the measured
// save claims are "Noted — I've captured that...", and cleanProse rewrites the
// clause dash to a comma, so the "Noted," form only becomes matchable after
// cleaning. A detector written against rawOutput found 27 of them; the same
// detector on cleaned text finds 40.
//
// PRECISION FIRST, deliberately. A false positive costs a wasted leg AND a
// rewrite of a sentence that was already correct; a false negative just leaves
// today's behaviour. Validated against the 73 G4 final replies that touch save
// vocabulary: 40 fire, 1 false positive, 3 known misses recorded in the tests.
// ---------------------------------------------------------------------------

/** Verbs that describe Mera having recorded something. */
const SAVE_VERB = 'noted|saved|added|stored|recorded|captured|logged';

/**
 * TRUE statements that use save vocabulary and must never be corrected.
 *
 * Every one of these is a real sentence from the corpus. "Nothing is stored
 * about you yet" and "they'll be saved when you tap" are both accurate and both
 * contain the words the claim detector looks for, so the allowlist is checked
 * FIRST and wins outright.
 */
const SAVE_SAFE = new RegExp(
  '(' +
    'nothing (?:is |was )?(?:stored|saved|recorded|noted)' +
    "|no facts are (?:saved|stored)" +
    "|do(?:n't|es not| not) have anything (?:saved|stored)" +
    '|your (?:saved|stored) (?:facts|location|profile)' +
    "|none of your (?:saved|stored) facts" +
    "|(?:they|it|those)(?:'ll| will) be saved" +
    '|will be saved' +
    '|nothing (?:stored|saved) yet' +
    '|before saving' +
    // answering about what is ALREADY on file. True, and uses the same words.
    "|(?:your|the) (?:saved|stored) fact" +
    "|(?:no|any) (?:saved|stored) facts" +
    '|nothing to delete' +
    "|(?:wasn't|was not) saved" +
    '|offered to save' +
    "|(?:check|confirm)[^.]{0,30}before saving" +
    "|already recorded" +
    ')',
  'i',
);

/**
 * Mera claiming it has ALREADY recorded what the user just said.
 *
 * False on every turn without exception: nothing persists until the user taps a
 * proposal card, so no reply is ever entitled to this. `facts/generic.md`
 * forbids the same words in prose; measured on G4, 10% of turns said it anyway
 * with a card on screen, which is the fourth time prompt wording has failed on
 * this model.
 */
const SAVE_CLAIM = new RegExp(
  '(' +
    `i(?:'ve|’ve| have)\\s+(?:just\\s+)?(?:${SAVE_VERB})\\b` +
    // sentence-initial: "Noted.", "Saved: ...", "Saved both facts: ..."
    `|^\\s*(?:${SAVE_VERB})\\b` +
    // mid-sentence close: "Nice, saved.", "Done, saved:", "That's recorded;"
    `|\\b(?:${SAVE_VERB})\\b\\s*[.:;]` +
    // "I have your note saved", words between the pronoun and the verb
    `|i(?:'ve|\u2019ve| have)\\s+[^.!?]{0,40}\\b(?:${SAVE_VERB})\\b` +
    `|\\b(?:${SAVE_VERB})\\s+that\\b` +
    `|\\b(?:${SAVE_VERB})\\s+(?:your|his|her|their|it)\\b` +
    `|\\bhave\\s+that\\s+(?:${SAVE_VERB})\\b` +
    `|\\b(?:is|are|was|were)\\s+(?:both\\s+)?(?:${SAVE_VERB})\\b(?!\\s+(?:about|yet))` +
    `|\\ball set\\b[^.]*\\b(?:${SAVE_VERB})\\b` +
    ')',
  'im',
);

/** True when the reply claims a save that has not happened. Pass CLEANED text. */
export function claimsSaveHappened(text: string): boolean {
  const t = text ?? '';
  if (!t.trim()) return false;
  // Allowlist wins outright: these sentences are true and use the same words.
  if (SAVE_SAFE.test(t)) return false;
  return SAVE_CLAIM.test(t);
}

/**
 * Scaffolding that belongs to the loop and must never appear in a bubble.
 *
 * The state block, the tool names, the skill ids, a thinking marker, and third
 * person about the user ("I'll extract the fact about their residence"). 4.3%
 * of G4 final replies carried one of these; 2.0% on the enforced arms.
 */
const INTERNALS = new RegExp(
  '(' +
    '<\\s*/?\\s*state\\s*>' +
    '|<\\s*/?\\s*known_facts\\s*>' +
    '|known_facts' +
    '|load_skill|saveExtractedFacts|find_similar_facts|lookup_place|ask_choice|deleteUserFacts' +
    '|\\bfacts/(?:residence|interest|origin|family|profession|generic)\\b' +
    '|\\bconversation/(?:question|correction)\\b' +
    '|\\btopics/(?:residence|interest|origin|family|profession|generic)\\b' +
    '|the state (?:notes|line|says|tells|block)' +
    '|\\[assistant thinking\\]' +
    '|\\banswerPending\\b|\\brouteKind\\b' +
    '|\\bthe user\\b' +
    '|\\btheir residence\\b' +
    ')',
  'i',
);

/** True when the reply exposes loop internals. Pass CLEANED text. */
export function leaksInternals(text: string): boolean {
  const t = text ?? '';
  return t.trim().length > 0 && INTERNALS.test(t);
}
