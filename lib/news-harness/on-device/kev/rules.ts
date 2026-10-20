// Layer 2: deterministic rules that override Kev. Pure and RN-free.

import { isPlainNo } from '../../../mera-harness/core/prose';

export type Consent = 'apply' | 'acknowledge' | 'decline' | 'none';

// Closed lists, matched against the whole message. Not the cloud's isPlainYes:
// that one counts "ok" and "please" as yes, and "ok" must never apply a card.
// "keep it" is in none: it declines a delete card but could mean save on a fact card.
const APPLY = /^(?:(?:ok(?:ay)?|yes|yeah|yep|yup|sure)[ ,]+)?(?:yes|yeah|yep|yup|sure|do it|go ahead|please do|apply it|yes please|sure thing)(?:[ ,]+(?:please|thanks|thank you|do it|go ahead|apply it))*$/;
const ACKNOWLEDGE = /^(?:ok|okay|cool|thanks|thank you|thx|nice|great|hmm+|got it|alright|fine)(?:[ ,]+(?:ok|okay|cool|thanks|thank you|nice|great|got it))*$/;
const DECLINE = /^(?:(?:no|nope|nah|please)[ ,]+)?(?:no|nope|nah|cancel|cancel it|don'?t|don'?t do (?:it|that)|do not|do not do (?:it|that)|never ?mind|forget it|leave it(?: as it is)?|not now|not yet|stop|no thanks|no thank you)(?:[ ,]+(?:thanks|thank you|cancel it|leave it|keep it|don'?t do (?:it|that)|do not do (?:it|that)|please))*$/;
// A "no" anywhere in the message. Not a decline on its own ("yes, and no more
// F1" is a yes), but Kev may never turn such a message into an apply.
const NEGATION = /(?:^|[^a-z'])(?:no|not|nope|nah|never|don'?t|do not|cancel|stop|wait|hold on)(?![a-z'])/;
// Ways of saying yes that contain a no: removed before the test, so they reach Kev unvetoed.
const YES_IDIOMS = /\b(?:no problem|no worries|not a problem|why not|not bad)\b/g;

function plain(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!?…]+$/u, '');
}

/**
 * What a message says about a card that is waiting. Call it only while a card
 * is pending. `apply` and `decline` act without asking Kev; `acknowledge`
 * ("ok", "thanks") VETOES a Kev agree_to_card, which is the point of the rule.
 * `none` (anything longer, "yes, and I follow F1", or another language) defers
 * to Kev. Order: decline, then apply, then acknowledge, so "no thanks" declines
 * and "ok, do it" applies.
 */
export function classifyConsent(message: string): Consent {
  const t = plain(message);
  if (!t) return 'none';
  if (DECLINE.test(t) || isPlainNo(t)) return 'decline';
  if (APPLY.test(t)) return 'apply';
  if (ACKNOWLEDGE.test(t)) return 'acknowledge';
  return 'none';
}

/**
 * True when the message says no somewhere. A Kev agree_to_card on such a
 * message is never applied: the flow asks agree or decline instead ("no wait,
 * don't apply that yet" must not apply a change).
 */
export function negates(message: string): boolean {
  return NEGATION.test(plain(message).replace(YES_IDIOMS, ' '));
}

// --- Fact comparison ---------------------------------------------------------
// The writer rewords saved facts ("You live in X" for "Lives in X"), so facts are
// compared as sets of content words, not as strings.

/** A leading subject: "You are", "I'm", "The user is"... */
const SUBJECT = /^(?:(?:the )?user|you|i|they)(?:'re|'m| are| am| is| has| have)?\s+/;
/** Function words and auxiliaries. Verbs like lives, works, interested stay: they tell facts apart. */
const STOPWORDS = new Set(
  'a an the in of on at to for and or with as by is are am was were be been being has have had do does my our your their his her its me i you we they he she it this that these those very really also still just now currently user'.split(' '),
);
/** Stems that mean "lives" (based, resides). */
const SYNONYMS: Record<string, string> = { bas: 'liv', resid: 'liv' };
/** ponytail: one fixed Jaccard bar, set by the unit-test table in rules.test.ts; widen the table before moving it. */
const SAME_FACT_MIN = 0.8;

/** ponytail: a light English suffix strip, enough for lives / living / lived and interests / interested. */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return SYNONYMS[w] ?? w;
}

/** The content words of a statement or a message: no subject, no accents, no function words, stemmed. */
function contentWords(text: string): Set<string> {
  const t = (text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(SUBJECT, '')
    .replace(/'(?:s|m|re|ve|ll|d)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return new Set(
    t
      .split(' ')
      .filter((w) => w && !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)))
      .map(stem),
  );
}

/**
 * True when `statement` says what `saved` says: nearly the same content words
 * (Jaccard >= 0.8), or a statement of two or more words that adds nothing to the
 * saved fact ("Lives in Porto" for "Lives in Porto, Portugal"). Asymmetric on
 * purpose: "Interested in AI safety" is new next to "Interested in AI".
 */
export function restates(statement: string, saved: string): boolean {
  const a = contentWords(statement);
  const b = contentWords(saved);
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared) >= SAME_FACT_MIN || (a.size >= 2 && shared === a.size);
}

/** True when `statement` says what a saved fact already says (the cloud's "already on file" form). */
export function isKnownFact(statement: string, known: readonly string[]): boolean {
  return known.some((k) => restates(statement, k));
}

/** Drops facts the user restated and repeats within the batch; keeps order. Empty statements go too. */
export function dropKnownFacts<T extends { statement: string }>(facts: readonly T[], known: readonly string[]): T[] {
  const seen = [...known];
  const out: T[] = [];
  for (const fact of facts) {
    if (contentWords(fact.statement).size === 0 || isKnownFact(fact.statement, seen)) continue;
    seen.push(fact.statement);
    out.push(fact);
  }
  return out;
}

/**
 * Drops facts the user did not state in `message`: none of their content words
 * are in it and all of them are in the saved facts, so the writer copied them
 * from its context. A fact with any word the saved facts lack stays, which keeps
 * an English fact for a message in another language. Pass the message Kev read
 * (KevChat.subject), so a chip tap grounds in the message it asked about.
 */
export function dropUngrounded<T extends { statement: string }>(facts: readonly T[], message: string, known: readonly string[]): T[] {
  const said = contentWords(message);
  const onFile = new Set(known.flatMap((k) => [...contentWords(k)]));
  return facts.filter((f) => {
    const words = [...contentWords(f.statement)];
    return words.some((w) => said.has(w)) || !words.every((w) => onFile.has(w));
  });
}

/** Ids that exist, each once, in the order given. */
export function existingIds(ids: readonly string[], known: Iterable<string>): string[] {
  const valid = new Set(known);
  return [...new Set(ids)].filter((id) => valid.has(id));
}
