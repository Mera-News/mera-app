// mera-harness/core — topic similarity. PURE, RN-free, no store or DB imports.
//
// ONE definition of "similar", TWO named thresholds. The filter and the eval
// scorer both import from here: two copies of a similarity rule is how a filter
// and the scorer measuring it silently stop measuring the same thing.

/** The FILTER drops at >= this. No subset clause, deliberately. */
export const FILTER_DROP_JACCARD = 0.75;

/** The SCORER flags at >= this, OR on isSubsetTopic. */
export const DETECT_JACCARD = 0.6;

/**
 * Why the two differ, and why the gap is the point.
 *
 * The filter acts at 0.75 and never on subsets; the scorer flags at 0.6 or on a
 * subset. So the 0.6-0.75 band and every subset case SURVIVE the filter into the
 * measured output. Were the two equal, the gate would measure its own filter and
 * read clean by construction — a metric that cannot fail, which is worse than no
 * metric. Both constants are exported so the gap is a visible decision rather
 * than two magic numbers drifting apart in two files.
 */

/**
 * FUNCTION WORDS ONLY.
 *
 * `news`, `update` and `latest` were in this list and had to come out: with
 * `news` stopped, "Amsterdam safety" and "Amsterdam safety news" both reduce to
 * {amsterdam, safety}, score 1.0 and one is dropped -- but they are two
 * different desks, and the second is a legitimate rung. Over-stopping empties
 * short topics and makes everything look alike, which is the failure mode this
 * filter must not have.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or',
  'the', 'to', 'with',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * WHY THERE IS NO PLACE-NAME EXCLUSION.
 *
 * There was one, built from the fact's resolved place chain, on the reasoning
 * that two topics sharing only a place name are not duplicates. Measured, it
 * did the opposite of its purpose: "Barcelona rail strikes" and "Spain rail
 * strikes" both reduce to {rail, strikes} once the places are stripped, score
 * 1.0, and one is dropped -- and `topics/residence` asks for exactly that pair,
 * a city transport topic and a country transport topic. The exclusion ate the
 * ladder it was meant to protect.
 *
 * Plain content-word Jaccard keeps all three shapes the guidelines produce:
 *   "Barcelona rail strikes"  vs "Spain rail strikes"        2/4 = 0.50  kept
 *   "Alkmaar hospital news"   vs "Alkmaar school closures"   1/5 = 0.20  kept
 *   "Amsterdam safety"        vs "Amsterdam safety news"     2/3 = 0.67  kept
 * All three sit under FILTER_DROP_JACCARD, and no subset rule means the third
 * survives on that count too. The tests pin all three.
 */

/** Jaccard over content words, stopwords removed. Nothing else is stripped. */
export function contentJaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** The shared content words between two topics — what a drop collided ON, so a
 *  drop can be read and argued with rather than trusted. */
export function sharedTokens(a: string, b: string): string[] {
  const tb = tokenize(b);
  return [...tokenize(a)].filter((t) => tb.has(t));
}

/**
 * True when a's content words are a subset of b's.
 *
 * The SCORER uses this; the FILTER must NOT. A ladder deliberately emits rungs
 * that contain each other ("Alkmaar hospital news" inside "Netherlands hospital
 * policy news"), so a subset rule in the filter eats the structure the skill
 * bodies exist to produce.
 */
export function isSubsetTopic(a: string, b: string): boolean {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return false;
  if (ta.size >= tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

/**
 * Words a fact is phrased with that are never its subject: "Lives in", "Works
 * as", "Follows", "since", counts. A topic sharing only these does not name
 * the fact.
 */
const FACT_FRAME_WORDS: ReadonlySet<string> = new Set([
  'is', 'are', 'was', 'be', 'has', 'have', 'had', 'my', 'our', 'their', 'his', 'her', 'its',
  'who', 'about', 'near', 'very', 'especially', 'since', 'year', 'years', 'week', 'weeks', 'month',
  'times', 'twice', 'once', 'one', 'two', 'three', 'round', 'all', 'part', 'time',
  'live', 'lives', 'living', 'work', 'works', 'working', 'follow', 'follows', 'likes', 'loves',
  'enjoys', 'reads', 'uses', 'owns', 'holds', 'plans', 'cares', 'worried', 'attends',
]);

/** The words that can carry a fact's subject. */
function subjectWords(text: string): string[] {
  return [...tokenize(text)].filter((w) => !FACT_FRAME_WORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * True when `topic` names `fact`'s own subject: a shared subject word, or a
 * shared 5-letter stem ("vegetarian" / "Vegetarian", "commuter" / "Commutes").
 * Used to keep a combination topic about its fact (ux2 F6) and to keep an
 * isolated call's dedupe list free of other facts' subjects.
 */
export function namesFact(topic: string, fact: string): boolean {
  const factWords = subjectWords(fact);
  const factSet = new Set(factWords);
  const factStems = new Set(factWords.filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
  return subjectWords(topic).some(
    (w) => factSet.has(w) || (w.length >= 5 && factStems.has(w.slice(0, 5))),
  );
}
