// Deterministic near-duplicate rejection for freshly generated topics.
//
// WHY A FILTER AND NOT MORE PROMPT. The blind rater flagged "near-duplicate of
// an existing topic" on 12 of 56 rows, and almost none were verbatim repeats:
// they were an existing topic with a scope word swapped in — "Logistics
// employment" coming back as "Rotterdam logistics employment", "Shipping
// industry" as "Shipping industry regulation". The model is shown the exclude
// list and still does this, and an exact-match check passes every one of them.
// A rule this mechanical belongs in code, where it is testable, not in a prompt
// where it is a suggestion.
//
// THE RULE IS STRUCTURAL, NOT FUZZY. Jaccard similarity was measured across the
// rater's rows at 0.6, 0.7, 0.8 and "off" and changed nothing at any threshold:
// every duplicate these rows contain is already caught by the subset rules
// below. A threshold that never fires is a knob someone will later tune in the
// belief it does something, so there isn't one.

/** Words that carry no retrieval meaning, so they must not make two topics look
 *  different. Kept deliberately short: every addition here widens what counts as
 *  a duplicate, and over-rejection is silent (the user just gets fewer topics). */
const GENERIC_TOKENS = new Set([
  'news', 'update', 'updates', 'latest',
  'the', 'of', 'a', 'an', 'and', 'in', 'for', 'on', 'to', 'at', 'by',
]);
// 'policy' is DELIBERATELY NOT here, though it looks generic. A round-3 device
// capture returned "Alkmaar hospital news" and "Netherlands hospital policy" as
// two good topics for one fact; with 'policy' stopped they both reduce to
// {hospital} and the second is eaten. Hospital policy is not hospital news, and
// "<place> <thing> policy" is the newsroom-shaped output the prompt work exists
// to produce. On the rater's rows keeping it costs 4 fewer rejections and
// changes neither the 10/11 caught nor the 0/5 protected.

/**
 * How many NEW content words a proposal must add to a broader existing topic
 * before it counts as a refinement rather than a restatement.
 *
 * One added word is a qualifier ("Rotterdam community news" → "Rotterdam expat
 * community news"). Two or more is a different subject.
 */
const MAX_QUALIFIER_TOKENS = 1;

/**
 * The smallest existing topic that may absorb a proposal through the
 * superset rule.
 *
 * LOAD-BEARING, and it is what keeps this filter from eating good topics. A
 * one-word existing topic ("Port of Rotterdam" reduces to `port` once the
 * ambient words are stripped) would otherwise swallow every proposal mentioning
 * that word,
 * including "Rotterdam port data analytics jobs", which the rater scored among
 * its strongest rows.
 */
const MIN_EXISTING_TOKENS_FOR_SUPERSET = 2;

export interface TopicDedupeResult {
  kept: string[];
  rejected: { topic: string; duplicateOf: string }[];
}

/** Lowercase, strip punctuation, drop the generic words. */
export function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !GENERIC_TOKENS.has(w));
}

/** The comparable subject of a topic: significant words minus the ambient ones. */
export function contentTokens(text: string, ambient: ReadonlySet<string>): Set<string> {
  return new Set(significantWords(text).filter((w) => !ambient.has(w)));
}

function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n += 1;
  return n;
}

/**
 * Fraction of the user's existing topics a word must appear in before it is
 * treated as AMBIENT and ignored when comparing.
 *
 * Nearly every topic for a location fact repeats the same place, so leaving it
 * in makes two unrelated topics look similar and two near-identical ones look
 * different. Measured across the rater's rows at 0.08, 0.10, 0.15 and 0.20:
 * 0.08 is the only one that catches the duplicates without touching a protected
 * row.
 */
const AMBIENT_TOKEN_FRACTION = 0.08;

/**
 * Below this many existing topics there is no frequency signal, so nothing is
 * treated as ambient. Stripping on a handful of rows would pick words out of
 * noise and could reduce a topic to nothing.
 */
const MIN_TOPICS_FOR_AMBIENT = 4;

/**
 * A word must also occur this many times, not just clear the fraction.
 *
 * The fraction alone is pathological on a short list: at 12 existing topics
 * 0.08 x 12 = 0.96, so a SINGLE occurrence makes a word ambient, every token set
 * empties and the filter silently stops rejecting anything. It fails open rather
 * than dangerously, which is exactly why it would have gone unnoticed — a unit
 * test on a realistic 12-topic persona is what caught it. Changes nothing on the
 * ~80-topic personas the rule was calibrated against.
 */
const MIN_AMBIENT_OCCURRENCES = 3;

/**
 * Words that appear across enough of the user's existing topics to carry no
 * discriminating power for THIS user.
 *
 * Derived from the data rather than guessed. An earlier version tried to detect
 * place names from capitalisation in the fact statement and was wrong in both
 * directions on real rows: it took "Port" out of "Port of Rotterdam" as a
 * place, and missed "Polish" because the fact never capitalised it. Frequency
 * needs no gazetteer and no NER, and it generalises past places — a user whose
 * every topic says "shipping" gets the same treatment.
 */
export function ambientTokens(existing: readonly string[]): Set<string> {
  if (existing.length < MIN_TOPICS_FOR_AMBIENT) return new Set();
  const counts = new Map<string, number>();
  for (const topic of existing) {
    for (const w of new Set(significantWords(topic))) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [w, n] of counts) {
    if (n >= MIN_AMBIENT_OCCURRENCES && n / existing.length >= AMBIENT_TOKEN_FRACTION) {
      out.add(w);
    }
  }
  return out;
}

/**
 * Drop proposals that restate a topic the user already has.
 *
 * Order is preserved, and each proposal is compared against the existing list
 * AND against the proposals already kept from this same call. Within-call
 * duplicates are real: a device capture returned "Netherlands sailing
 * regulations" and "IJsselmeer sailing safety regulations" in one four-item
 * answer, differing only by a scope word and a place. Earlier wins, because the
 * model emits its best first and the list is ranked.
 *
 * Empty token sets on EITHER side are skipped. An existing topic that reduces to
 * nothing once its place and generic words are stripped ("Poland news" → {})
 * would otherwise match everything and delete the whole fact's topics. That
 * costs one true positive the rater flagged, and it is the right trade: a filter
 * that can empty a fact is worse than one that lets a duplicate through.
 */
export function filterNearDuplicateTopics(
  proposed: readonly string[],
  existing: readonly string[],
  options: { ambient?: ReadonlySet<string> } = {},
): TopicDedupeResult {
  const ambient = options.ambient ?? ambientTokens(existing);
  const existingSets = existing
    .map((text) => ({ text, tokens: contentTokens(text, ambient) }))
    .filter((e) => e.tokens.size > 0);

  const kept: string[] = [];
  const rejected: { topic: string; duplicateOf: string }[] = [];
  // Grows as proposals survive, so the comparison set is existing + kept-so-far.
  const comparisonSets = [...existingSets];

  for (const topic of proposed) {
    const tokens = contentTokens(topic, ambient);
    if (tokens.size === 0) {
      kept.push(topic);
      continue;
    }
    const hit = comparisonSets.find(
      (e) =>
        // The proposal says nothing the existing topic does not already say.
        isSubset(tokens, e.tokens) ||
        // The proposal is the existing topic plus a qualifier.
        (isSubset(e.tokens, tokens) &&
          e.tokens.size >= MIN_EXISTING_TOKENS_FOR_SUPERSET &&
          difference(tokens, e.tokens) <= MAX_QUALIFIER_TOKENS),
    );
    if (hit) {
      rejected.push({ topic, duplicateOf: hit.text });
    } else {
      kept.push(topic);
      comparisonSets.push({ text: topic, tokens });
    }
  }

  return { kept, rejected };
}
