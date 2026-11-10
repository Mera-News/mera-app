// The reader's own words on a follow card: APP CODE adds them, so they are there
// whatever the model wrote. Pure and RN-free; cloud and on-device share it.
//
// Slots, within the parser's cap of 4: [exact, corrected, story, story]. The
// corrected row is the model's option that passes `isCloseToPhrase`, wherever
// it put it. One that fails stays an ordinary story option. The two rows share
// one when they differ only by case or trailing punctuation.

import { isAcknowledgement, isPlainYes } from '../../../mera-harness/core/prose';

/** MAX_TRACK_OPTIONS in the staging parser: built here, so it evicts neither phrase row. */
const TRACK_CARD_SLOTS = 4;
/** MAX_TRACK_CHARS in the staging parser. A longer text would be cut, so it is no longer their words. */
const MAX_PHRASE_CHARS = 200;

/** English only: any other language keeps the whole message, which is still their words. */
const LEAD_INS: readonly RegExp[] = [
  /^(?:yes|yeah|ok|okay)[,.]?\s+/i,
  /^(?:no[,.]?\s+)?i\s+meant\s+/i,
  /^(?:(?:please|can you|could you|would you)\s+)*(?:i(?:\s+would|['’]d)?\s+(?:want|like|wanna)\s+(?:you\s+)?(?:to\s+)?)?(?:keep me (?:updated|posted|informed)|update me|keep an eye|keep tabs|get updates|give me updates|updates?|news|follow|track(?!\s+and\b))(?:\s+(?:on|about|of|with))?\s+(?:the\s+(?:story|news)\s+(?:of|on|about)\s+)?/i,
];
const TRAILING_PLEASE = /[\s,]*please[.!]*$/i;
/** Names nothing: "this", "that story", "a story", "something else". */
const NAMES_NOTHING = /^(?:(?:this|that|these|those|it|them|the|a|an|one|some)\s*)?(?:story|stories|one|news|something|thing|topic)?(?:\s+else)?[.!?]*$/i;
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export type PhraseRole = 'exact' | 'corrected';

/** Rides the tool result: the option list itself passes through a parser that keeps label and search only. */
export interface PhraseCardHints {
  /** Normalised label to role. */
  phraseRoles: Record<string, PhraseRole>;
  /** Normalised label of the row ticked by default. */
  defaultTick: string;
}

export interface TrackOptionText {
  label: string;
  search: string;
}

/** The same key as the card's `normaliseTrackText`. */
export function phraseKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The story the reader named, in their words, or null when the message names none. */
export function readerPhrase(message: string): string | null {
  let phrase = (message ?? '').trim().replace(/\s+/g, ' ');
  for (const leadIn of LEAD_INS) phrase = phrase.replace(leadIn, '');
  phrase = phrase.replace(TRAILING_PLEASE, '').trim();
  if (!/\p{L}/u.test(phrase) || phrase.length > MAX_PHRASE_CHARS) return null;
  if (NAMES_NOTHING.test(phrase) || isPlainYes(phrase) || isAcknowledgement(phrase)) return null;
  return phrase;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length];
}

const fold = (s: string): string =>
  s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const nearWord = (a: string, b: string): boolean => distance(a, b) <= (Math.min(a.length, b.length) >= 5 ? 2 : 1);

/** A filler the fix may add or drop: short and not an acronym that would be a new name. */
const isFiller = (word: string, raw: string): boolean =>
  word.length <= 3 && !raw.split(/\s+/).some((w) => w.length > 1 && w === w.toUpperCase() && fold(w) === word);

/**
 * Same words, same meaning: every word on each side sits within a small edit
 * of a word on the other, so a new name, a rewrite or a translation fails.
 * Scripts written without spaces compare by character.
 */
export function isCloseToPhrase(phrase: string, candidate: string): boolean {
  const a = fold(phrase);
  const b = fold(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  if (NO_SPACE_SCRIPT.test(phrase)) return distance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 4));
  const aw = a.split(' ');
  const bw = b.split(' ');
  return (
    aw.every((w) => isFiller(w, phrase) || bw.some((o) => nearWord(w, o))) &&
    bw.every((w) => isFiller(w, candidate) || aw.some((o) => nearWord(w, o)))
  );
}

const noTrailingPunctuation = (s: string): string => phraseKey(s).replace(/[\s\p{P}]+$/u, '');
/** The words that make two labels one story: case, end punctuation and a leading English article aside. */
const sameStoryKey = (s: string): string => noTrailingPunctuation(s).replace(/^(the|a|an) /, '');

function optionRows(raw: unknown): TrackOptionText[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const rec = (typeof entry === 'string' ? { label: entry } : entry) as Record<string, unknown> | null;
    const label = typeof rec?.label === 'string' ? rec.label.trim() : '';
    if (!label) return [];
    const search = typeof rec?.search === 'string' ? rec.search.trim() : '';
    return [{ label, search: search || label }];
  });
}

/**
 * The card's options with the reader's words on it, or null when the message
 * names no story or the model offered nothing (it asked which story instead).
 * `appIsEnglish`: the exact row is ticked by default only for an English phrase
 * (app language en, all ASCII), because followed-story matching is in English.
 */
export function withReaderPhrase(
  raw: unknown,
  message: string,
  appIsEnglish: boolean,
): { options: TrackOptionText[]; hints: PhraseCardHints } | null {
  const phrase = readerPhrase(message);
  const rows = optionRows(raw);
  if (!phrase || rows.length === 0) return null;

  const at = rows.findIndex((o) => isCloseToPhrase(phrase, o.label));
  const corrected = at >= 0 ? rows[at] : null;
  const stories = rows.filter((_, i) => i !== at);
  const exact: TrackOptionText = { label: phrase, search: phrase };

  const oneRow = corrected !== null && sameStoryKey(corrected.label) === sameStoryKey(phrase);
  const head = oneRow ? [corrected] : corrected ? [exact, corrected] : [exact];
  const taken = new Set(head.map((o) => phraseKey(o.label)));
  const options = [...head, ...stories.filter((o) => !taken.has(phraseKey(o.label)))].slice(0, TRACK_CARD_SLOTS);

  const phraseRoles: Record<string, PhraseRole> = {};
  if (!oneRow || corrected?.label === phrase) phraseRoles[phraseKey(phrase)] = 'exact';
  if (corrected && corrected.label !== phrase) phraseRoles[phraseKey(corrected.label)] = 'corrected';

  const english = appIsEnglish && /^[ -~]*$/.test(phrase);
  const tick = corrected ?? (english ? exact : options[1] ?? exact);
  return { options, hints: { phraseRoles, defaultTick: phraseKey(tick.label) } };
}
