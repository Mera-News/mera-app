// mera-harness/core: an interest with no stake becomes a follow card. PURE.
//
// The model only fills two slots on a facts/interest save. Everything here is
// the loop's: what counts as a subject, where it sits on the card, and the note
// that drives the follow skill for the rest of the turn.

import { escapeUntrusted } from './state-line';

/** The parser's own cap (`MAX_TRACK_OPTIONS`). */
const CARD_SLOTS = 4;
/** A subject is a name. A longer text is a sentence about the reader. */
const MAX_SUBJECT_WORDS = 8;
const MAX_SUBJECT_CHARS = 80;
/** A message this short may be nothing but the subject. */
const MIN_SENTENCE_WORDS = 3;

// shortcut: first-person words for the languages the eval covers (en, nl, hi).
// Any other language relies on the whole-message test below, so a fragment like
// "mi equipo Ajax" gets through; add that language's words if a hand read finds one.
const FIRST_PERSON = new Set([
  'i', 'im', "i'm", 'i’m', 'ive', "i've", 'i’ve', 'id', "i'd", 'i’d', 'my', 'mine', 'me', 'myself', 'we', "we're", 'we’re', 'our', 'ours', 'into',
  'ik', 'mijn', 'mij', 'wij', 'ons', 'onze',
  'मैं', 'मेरा', 'मेरी', 'मेरे', 'मुझे', 'मुझको', 'हम', 'हमारा', 'हमारी', 'हमारे', 'हमें',
]);

const words = (s: string): string[] =>
  s.toLowerCase().split(/[^\p{L}\p{M}\p{N}'’]+/u).filter(Boolean);

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether a text can go on the card as a subject. THE STRUCTURAL TEST is the one
 * that works in every language: a message handed back whole is a sentence about
 * the reader, whatever its words. Refusing costs only the first row: the card
 * opens on the model's own options.
 */
export function isUsableSubject(subject: unknown, message: string): subject is string {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > MAX_SUBJECT_CHARS) return false;
  const said = words(subject);
  if (said.length === 0 || said.length > MAX_SUBJECT_WORDS) return false;
  if (said.some((w) => FIRST_PERSON.has(w))) return false;
  return !(said.length >= MIN_SENTENCE_WORDS && said.join(' ') === words(message).join(' '));
}

/** The model writes "cycling"; every other row on the card is Title Case. */
const capitalised = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** The subjects that may lead the card, in the order the model gave them. */
export function storySubjects(entries: readonly Record<string, unknown>[], message: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const subject = e.story_subject;
    if (isUsableSubject(subject, message) && !out.some((s) => sameText(s, subject))) out.push(capitalised(subject.trim()));
  }
  return out.slice(0, CARD_SLOTS);
}

function optionRows(raw: unknown): { label: string; search: string }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((o) => {
    const rec = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
    const label = typeof rec?.label === 'string' ? rec.label.trim() : '';
    const search = typeof rec?.search === 'string' ? rec.search.trim() : '';
    return label ? [{ label, search: search || label }] : [];
  });
}

/**
 * The handover's card: the subjects first, then the model's own options that are
 * neither personal nor a copy of a subject. A subject's search is the one the
 * model wrote for that very label when it wrote one (in English, where matching
 * happens; the subject is in the reader's language), else the subject itself.
 */
export function subjectsFirst(args: Record<string, unknown>, subjects: readonly string[], message: string): Record<string, unknown> {
  const rows = optionRows(args.options);
  const first = subjects.map((label) => {
    const own = rows.find((r) => sameText(r.label, label))?.search;
    return { label, search: own && isUsableSubject(own, message) ? own : label };
  });
  const rest = rows.filter((r) => isUsableSubject(r.label, message) && !first.some((f) => sameText(f.label, r.label)));
  return { ...args, options: [...first, ...rest].slice(0, CARD_SLOTS), storySubjects: [...subjects] };
}

/** The last thing a follow leg reads. It overrides the skill's one line beside
 *  the card: that line is for a reader who asked to follow. */
export function followHandoverNote(subjects: readonly string[]): string {
  const named = subjects.map((s) => `"${escapeUntrusted(s, 80)}"`).join(', ');
  return (
    (named
      ? `They like ${named}, with no effect on their life, so it is a story to follow. Options come first with exactly that label and its search in English. `
      : 'They said they like something, with no effect on their life, so it is a story to follow. ')
    + 'Then add narrower or wider options. No option says I, my or anything about them. '
    + 'Call proposeTrack now, using the search results above if there are any; when they are empty, write the options from what they named. '
    + 'Beside the card write one or two short sentences in the language of their message: this one is good to follow, '
    + 'and new articles land in Followed stories once they tick what they want and tap Follow. '
    + 'Say nothing about their profile, or about why it is not a fact.'
  );
}

/** Written beside a follow card the reader answered "no effect" about. */
export const NO_IMPACT_NOTE =
  'They said it does not affect them. Write ONE short sentence, in the language of their message: following it on the card above suits it best. '
  + 'Do not say anything was saved, added or followed. Do not call a tool.';

export function withoutStakeSlots(entry: Record<string, unknown>): Record<string, unknown> {
  const { has_stake: _stake, story_subject: _subject, ...rest } = entry;
  return rest;
}

/** What "Add it anyway" commits, on the card's own result. */
export function profileOfferEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const { statement, questionnaire_attribute, topic_skill_id } = entry;
  return {
    statement,
    ...(typeof questionnaire_attribute === 'string' ? { questionnaire_attribute } : {}),
    ...(typeof topic_skill_id === 'string' ? { topic_skill_id } : {}),
  };
}
