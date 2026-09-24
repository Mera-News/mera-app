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

/** Sentence boundary, keeping the separator so the kept prefix can be
 *  reassembled with its original whitespace. `split` with a capturing group
 *  yields [sentence, separator, sentence, ...], so the even indices are the
 *  sentences. Lookbehind keeps the terminator on the sentence it ends, which
 *  `trailingQuestion` above already relies on. */
const SENTENCE_BOUNDARY = /((?<=[.!?…])\s+|\n+)/;

/** How many opening words make two sentences "the same sentence again". */
const REPEAT_PREFIX_WORDS = 6;

/** Words only, case and punctuation folded away, so a repeat is recognised
 *  across a changed comma or a smart quote. Unicode-aware: a Russian or Arabic
 *  reply must fold the same way, and `[a-z]` would empty it. */
function proseWords(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Cut a reply at the point it starts repeating itself.
 *
 * THE DEFECT THIS EXISTS FOR, measured on device: a `conversation/correction`
 * turn answered "Done. The chess fact is gone." and then wrote "I removed the
 * chess hobby you had on file. Let me know if you need anything else." about
 * fifteen times, alternating two closers, until it hit the token cap and
 * truncated mid-word. That reply was persisted and shown. It was the loop's own
 * `reply`, not an accumulation across legs: the turn summary logged
 * `replyChars: 1227` against a maximum of 183 on every other turn of the
 * session, so the model genuinely generated it.
 *
 * A CUT, not a de-duplication. Dropping the repeats and keeping the tail would
 * leave the mid-word truncation as the last thing the user reads. Everything
 * from the first repeat on is the loop.
 *
 * This is the one reply defect that gets a deterministic rewrite rather than a
 * re-ask, and the distinction is the point: for a false save claim the wording
 * IS the content, so a strip would mangle a real sentence and the re-ask is
 * worth its leg. Repeats two through fifteen carry no information at all, so
 * removing them loses nothing, and a model that has just looped is the worst
 * candidate for being asked to try again.
 *
 * Precision first, since this runs on every reply:
 *  - three sentences minimum, because a loop is a RUN and two sentences that
 *    happen to rhyme are not one;
 *  - a whole-sentence repeat counts at any length, which is unambiguous;
 *  - a prefix repeat needs six words on both sides, so "Got it." and "Got it,
 *    noted." never collide.
 */
export function collapseRepetitionLoop(text: string): string {
  if (!text) return text;
  const parts = text.split(SENTENCE_BOUNDARY);
  // Even indices are sentences; fewer than three of them is not a loop.
  if (parts.length < 5) return text;

  const wholes = new Set<string>();
  const prefixes = new Set<string>();
  for (let i = 0; i < parts.length; i += 2) {
    const words = proseWords(parts[i]);
    if (words.length === 0) continue;
    const whole = words.join(' ');
    const prefix =
      words.length >= REPEAT_PREFIX_WORDS
        ? words.slice(0, REPEAT_PREFIX_WORDS).join(' ')
        : null;
    if (wholes.has(whole) || (prefix !== null && prefixes.has(prefix))) {
      return parts.slice(0, i).join('').trim();
    }
    wholes.add(whole);
    if (prefix !== null) prefixes.add(prefix);
  }
  return text;
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
 *
 * The repetition cut runs between the two: it splits on sentence ends, and a
 * clause dash rewritten to a comma can only join text that would otherwise
 * have been read as one sentence anyway, while the whitespace collapse must
 * come last so it also tidies whatever the cut left at the seam.
 */
export function cleanProse(text: string): string {
  if (!text) return text;
  return collapseRepetitionLoop(replaceClauseDashes(text))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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
    // A NEGATIVE: "no new specifics were added" says the opposite of a save
    // claim (device capture, ux1 C3).
    "|\\bno (?:new )?(?:\\w+ ){0,2}(?:were|was|has been|have been) (?:added|saved|recorded|noted|stored)" +
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
    // TOOL ARGUMENT KEYS, not just tool names. A model that writes its tool
    // call out as prose names the ARGUMENTS, never the function: the reply
    // that shipped read `{"extracted_user_information": [{"statement": ...,
    // "questionnaire_attribute": "interests"}]}` and matched nothing here.
    // snake_case keys, so they cannot collide with English.
    '|extracted_user_information|questionnaire_attribute|topic_skill_id|fact_ids|placeChain|countryHint' +
    '|\\bthe user\\b' +
    '|\\btheir residence\\b' +
    ')',
  'i',
);

/**
 * A reply that is a serialised object rather than a sentence.
 *
 * Listing internal key names catches the ones already seen and nothing else,
 * and the model invents new shapes faster than a word list grows. This is the
 * structural half: Mera's replies are prose, so a bubble opening with `{` or
 * `[` is a tool call the model wrote out as text instead of calling.
 *
 * Deliberately narrow. It checks the OPENING character rather than searching
 * for braces anywhere, so an ordinary sentence that happens to quote one is
 * untouched, and it requires a quoted key so `{` alone is not enough.
 */
export function looksLikeSerialisedPayload(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  if (t[0] !== '{' && t[0] !== '[') return false;
  return /"[A-Za-z_][A-Za-z0-9_]*"\s*:/.test(t);
}

/** True when the reply exposes loop internals. Pass CLEANED text. */
export function leaksInternals(text: string): boolean {
  const t = text ?? '';
  if (t.trim().length === 0) return false;
  return INTERNALS.test(t) || looksLikeSerialisedPayload(t);
}

/**
 * The loop narrating its own process, or promising a step it has not taken.
 *
 * Two device replies this exists for, both shipped as the WHOLE reply:
 * "I'll start by loading the appropriate skill for this turn." (the route
 * leg's acknowledgement, left standing when every later leg was silent) and
 * "Let me check what you already follow, then I can offer this." (a turn that
 * spent its legs looking things up and ended with no offer). Neither answers
 * the user; both describe work instead of doing it.
 *
 * PRECISION FIRST, like the two detectors above. The verbs are ones the loop
 * actually narrates (check, look, load, search, find, verify), gated on a
 * first-person future. "Let me know what else you follow" and "I'll be here"
 * are ordinary sentences and do not match. A miss leaves today's behaviour; a
 * false positive re-asks a correct reply, so the list stays narrow.
 */
const PROCESS_NARRATION = new RegExp(
  '(' +
    "\\b(?:let me|i(?:'ll|’ll| will)|i(?:'m|’m| am) going to)\\s+(?:first\\s+|quickly\\s+|just\\s+)?" +
    '(?:check|look (?:up|at|for|into|through)|load|search|find|verify|pull up|fetch|figure out|go through|review)\\b' +
    "|\\bthen i(?:'ll|’ll| will| can)\\s+(?:offer|add|propose|suggest|save)\\b" +
    '|\\b(?:the|an?) (?:appropriate|right|relevant) (?:skill|guideline|tool)\\b' +
    '|\\bloading (?:the|a|an) (?:skill|guideline|instructions)\\b' +
    '|\\bone moment while i\\b' +
    // Narrating how it READ the message: "I read that as answering the Porto
    // question, but the word does not fit." (device capture, ux1 C4)
    "|\\bi(?:'m|’m| am)? ?(?:read|took|reading|interpreted|understood) (?:that|this|it|your (?:message|reply|answer)) as\\b" +
    '|\\bas (?:an? )?(?:answer|reply) to (?:the|your|my) .{0,40}question\\b' +
    ')',
  'i',
);

/** True when the reply narrates the loop's process or promises an unmade
 *  offer. Pass CLEANED text. */
export function narratesProcess(text: string): boolean {
  const t = text ?? '';
  if (!t.trim()) return false;
  // A CONDITIONAL offer is an ordinary sentence, not narration: "If you tell
  // me where you live, I'll look up the place" is a correct answer from the
  // G4 corpus. The whole conditional sentence is set aside before matching.
  const unconditional = t.replace(/\b(?:if|once|when) you\b[^.?!]*[.?!]?/gi, ' ');
  return PROCESS_NARRATION.test(unconditional);
}

/**
 * A plain yes typed in answer to Mera's last question.
 *
 * Short and closed on purpose: a yes that carries anything else ("yes, and I
 * also follow F1") is a new message and routes normally. Never a
 * confirmation of anything destructive; the loop only uses it to resume the
 * subject the question was about.
 */
const PLAIN_YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|please do|go ahead|do it|sounds good|that'?s right|correct)(?:[ ,]+(?:please|thanks|thank you|add it|add that|do it|go ahead))*[.!]*$/i;

/**
 * The reply says there is nothing to add: the fact is already on file, or the
 * profile stays as it is. A forced offer after this sentence contradicts it on
 * screen (ux1 C3: "That's already on file... I'll leave your profile as it is"
 * above a card offering the same fact).
 */
const NOTHING_TO_ADD = new RegExp(
  '(' +
    "\\b(?:that['’]?s|that is|this is|it['’]?s|it is|those are|they['’]?re) already (?:on file|in your profile|saved|there)\\b" +
    "|\\balready (?:have|had|hold) (?:that|this|it|those)\\b" +
    "|\\bleave your profile as it is\\b" +
    "|\\bnothing (?:new )?to add\\b" +
    ')',
  'i',
);

export function declaresNothingToAdd(text: string): boolean {
  return NOTHING_TO_ADD.test(text ?? '');
}

/**
 * A statement in comparable form: lowercased, articles and a leading "user"
 * dropped, punctuation and spacing collapsed. Used ONLY to recognise a fact
 * already on file, so a near-identical re-offer is caught the way an exact one
 * is. Never written back.
 */
export function comparableStatement(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/^(?:the )?user\s+/, '')
    .replace(/[^a-z0-9\u00c0-\uffff\s]/g, ' ')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPlainYes(text: string): boolean {
  const t = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || t.split(' ').length > 6) return false;
  return PLAIN_YES.test(t);
}

const PLAIN_NO = /^(?:no|nope|nah|no thanks|no thank you|not really|not now|skip it|don'?t|do not)(?:[ ,]+(?:thanks|thank you))*[.!]*$/i;

/** A plain no to Mera's last question, from the same closed register as
 *  `isPlainYes`. */
export function isPlainNo(text: string): boolean {
  const t = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || t.split(' ').length > 6) return false;
  return PLAIN_NO.test(t);
}
