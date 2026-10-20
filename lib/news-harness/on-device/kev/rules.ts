// Layer 2: deterministic rules that override Kev. Pure and RN-free.

import { comparableStatement, isPlainNo } from '../../../mera-harness/core/prose';

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

/** True when `statement` says what a saved fact already says (the cloud's "already on file" form). */
export function isKnownFact(statement: string, known: readonly string[]): boolean {
  const key = comparableStatement(statement);
  return key !== '' && known.some((k) => comparableStatement(k) === key);
}

/** Drops facts the user restated and repeats within the batch; keeps order. Empty statements go too. */
export function dropKnownFacts<T extends { statement: string }>(facts: readonly T[], known: readonly string[]): T[] {
  const seen = new Set(known.map(comparableStatement));
  const out: T[] = [];
  for (const fact of facts) {
    const key = comparableStatement(fact.statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

/** Ids that exist, each once, in the order given. */
export function existingIds(ids: readonly string[], known: Iterable<string>): string[] {
  const valid = new Set(known);
  return [...new Set(ids)].filter((id) => valid.has(id));
}
