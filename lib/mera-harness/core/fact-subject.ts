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

/** The multi-valued interest keys (facts/interest's table). A person holds many
 *  facts under each, so a shared key alone says nothing about which one a new
 *  fact would replace. */
const INTEREST_KEYS = new Set([
  'hobbies', 'sports_playing', 'teams_following', 'entertainment_genres', 'artists_creators_following', 'topics',
]);

export function isInterestKey(attribute: string | null | undefined): boolean {
  return INTEREST_KEYS.has(attributeKey(attribute));
}

/** The verbs an interest fact is phrased with. Never its subject: "Supports
 *  Ajax" and "Supports Feyenoord" share only the verb, and `namesFact` keeps
 *  every word outside its own frame list. */
const INTEREST_FRAME = /\b(?:no longer|plays|playing|supports|supporting|listens|listening|watches|watching|interested|fan|fans)\b/gi;

/** The statement with its interest verbs removed, for a subject check. */
export function interestSubject(statement: string): string {
  return statement.replace(INTEREST_FRAME, ' ');
}

/**
 * A NEGATIVE interest ("No longer follows cricket news", "Does not want
 * celebrity gossip topics", "Mutes The Hindu"), dropped from a FORCED leg on
 * an ordinary turn. Facts are stored in English, so this reads the OFFER
 * whatever language the user wrote in. Precision first, because a hit loses a
 * card: a negation or a dislike needs an interest word too ("Does not want
 * children", "Dislikes spicy food", "Avoids gluten", "Does not read German"
 * are facts), and "follow a(n)" is not one ("Does not follow a diet"). A
 * seeing verb counts only with "about" after it ("Does not want to be shown
 * anything about Bollywood"). "Mutes" needs nothing more.
 */
const NEGATIVE_LEAD = /^(?:does not|doesn['’]t|do not|don['’]t|is not|isn['’]t|no longer|not|never|no|prefers not|wants no|wants less|wants fewer|dislikes|avoids|hates|blocks)\b/i;
const INTEREST_WORD = /\bfollow\w*\b(?!\s+an?\b)|\b(?:interest\w*|news|gossip|content|topics?|stories|updates|coverage|articles|headlines|sources?|recommend\w*)\b|\b(?:see|hear|read|watch|shown?|showing|receive|get)\b(?:\s+\S+){0,3}?\s+about\b/i;

export function isNegativeInterest(statement: string): boolean {
  const s = (statement ?? '').trim();
  return /^mutes\b/i.test(s) || (NEGATIVE_LEAD.test(s) && INTEREST_WORD.test(s));
}

/**
 * Any negative or reduced interest, interest word or not ("Does not want
 * cricket", "Not a fan of cricket", "Wants to see less cricket", "Unfollowed
 * cricket"). Read only on a see-less turn, where stop / less / mute / hide
 * stage a filter and never a card (owner ruling), so nothing narrower holds.
 * A home, a job or a study stays: "Stop cricket, I no longer live in Paris".
 */
const SEE_LESS_LEAD = /^(?:does not|doesn['’]t|do not|don['’]t|is not|isn['’]t|is no longer|no longer|not|never|no|has no|has lost|lost|prefers not|prefers less|prefers fewer|wants no|wants less|wants fewer|wants to see (?:less|fewer)|dislikes|avoids|hates|blocks|mutes|hides|unfollow\w*|stopped|stops)\b(?!\s+(?:longer\s+)?(?:lives?|lived|living|works?|worked|working|stud(?:y|ies|ied|ying))\b)/i;

export function isSeeLessOffer(statement: string): boolean {
  const s = (statement ?? '').trim();
  return isNegativeInterest(s) || SEE_LESS_LEAD.test(s);
}

/** "Not interested in golf": the negative shape that IS a fact when the user
 *  said so (owner ruling), unlike a stop, mute or hide request. "No longer
 *  interested" and "no interest in" read the same. */
export function isNotInterested(statement: string): boolean {
  return /^(?:(?:is )?(?:not|no longer)|isn['’]t) interested\b|^(?:has )?no interest in\b/i.test((statement ?? '').trim());
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
