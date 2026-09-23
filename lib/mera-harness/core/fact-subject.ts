// Whose fact is this?
//
// A persona fact is about the USER or about someone in their life, and the two
// are not interchangeable. The distinction is invisible to the loop everywhere
// except one place where it destroys data, so it lives in its own tiny module
// rather than inside `core.ts`: it is pure, it is testable on its own, and the
// eval needs it without dragging the loop in.

/**
 * A subject that is SOMEONE ELSE.
 *
 * Kept in the harness rather than imported from `news-harness`, which has its
 * own copy for the topic-generation location resolver. The harness core may not
 * import outside itself, and a second copy of a word list is cheaper than the
 * boundary violation. They are allowed to drift: that one vetoes a location
 * anchor, this one vetoes a destructive replace.
 */
const RELATIONAL_SUBJECT =
  /\b(parents?|mother|father|mom|mum|dad|family|in-?laws?|sibling|brother|sister|partner|spouse|wife|husband|girlfriend|boyfriend|friends?|colleagues?|son|daughter|children|kids|grandparents?|grandmother|grandfather|relatives?|cousins?)\b/i;

/** True when the statement is about someone other than the user. */
export function isRelationalStatement(statement: string): boolean {
  return RELATIONAL_SUBJECT.test(statement ?? '');
}

/**
 * May `candidate` replace `target`?
 *
 * THE DEFECT THIS EXISTS FOR, reported from TestFlight: "My girlfriend's
 * parents live in Porto Santo" resolved to Vila Baleira and was then offered as
 * a replacement for "Lives in Amsterdam, North Holland, The Netherlands, EU" —
 * the USER's own home. Accepting that card would have moved the user to a
 * Portuguese island because someone else's parents live there, and a replace is
 * a destroy: the old fact and every topic under it go for good.
 *
 * The loop already required a CONFIRMED choice before honouring `replaces`, and
 * that guard held. It was the wrong guard for this: the user did choose, they
 * just chose which Porto Santo, not which of their facts to delete.
 *
 * The rule is subject agreement, checked both ways. A fact about someone else
 * may not replace a fact about the user, and a fact about the user may not
 * replace a fact about someone else. Two relational facts may replace each
 * other, which is deliberately permissive: "parents live in Bhopal" correcting
 * "parents live in Delhi" is a real correction, and distinguishing whose
 * parents is beyond a word list.
 *
 * Refusing is cheap. The proposal still reaches the user as a NEW fact, so
 * nothing is lost and the worst case is one stale fact they can delete.
 */
export function mayReplace(candidate: string, target: string): boolean {
  return isRelationalStatement(candidate) === isRelationalStatement(target);
}

/** The attribute KEY: the text before the first ': ', lowercased. The router
 *  and every fact skill already match facts on it. */
export function attributeKey(attribute: string | null | undefined): string {
  if (typeof attribute !== 'string') return '';
  return attribute.split(':')[0].trim().toLowerCase();
}

/** Both facts carry the same non-empty attribute key. */
export function sameAttributeKey(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = attributeKey(a);
  return ka !== '' && ka === attributeKey(b);
}

/** The keys that mark where the user currently lives. Mirrors
 *  `isLocationAttribute` in news-harness, which this folder may not import. */
const LOCATION_KEYS = new Set(['location', 'neighborhood', 'residence', 'home']);

export function isLocationKey(attribute: string | null | undefined): boolean {
  return LOCATION_KEYS.has(attributeKey(attribute));
}

/**
 * May a fact under `candidateAttribute` REPLACE one under `targetAttribute`?
 *
 * A home fact may only be replaced by another home fact. The location key is
 * what anchors every future topic run to where the user lives, and a fact
 * under any other key replacing it drops that anchor: an origin fact written
 * as "Expat from India living in Amsterdam" once replaced "Lives in
 * Nieuw-West, Amsterdam" and took the neighbourhood and the canonical key with
 * it. Refused replaces are demoted to plain adds, as for subject agreement.
 */
export function mayReplaceKey(
  candidateAttribute: string | null | undefined,
  targetAttribute: string | null | undefined,
): boolean {
  if (!isLocationKey(targetAttribute)) return true;
  // No key at all says nothing about what the fact is, so it is not refused
  // on key grounds; subject agreement still applies.
  if (attributeKey(candidateAttribute) === '') return true;
  return isLocationKey(candidateAttribute);
}
