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

/** Words that carry no topical signal. Kept deliberately small: over-stopping
 *  empties short topics and makes everything look similar. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or',
  'the', 'to', 'with', 'news', 'update', 'updates', 'latest',
]);

function tokenize(text: string, exclude: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    if (exclude.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Build the place-name exclusion set from a fact's RESOLVED place chain.
 *
 * Structural, never a capitalisation heuristic: this repo has already paid for
 * that one, where it stripped "Port" out of "Port of Rotterdam" and missed
 * "Polish". `lookup_place` already resolved these, so they are known rather than
 * guessed.
 *
 * NO place chain => EMPTY set => place names stay in the token set, which
 * INFLATES similarity between two topics that share a place.
 *
 * THAT FALLBACK IS SAFE ONLY BECAUSE FILTER_DROP_JACCARD IS 0.75. Worked worst
 * cases with place names left in:
 *   "Alkmaar hospital news" vs "Alkmaar school closures"  -> 1/4 = 0.25
 *   "Alkmaar hospital news" vs "Alkmaar hospital policy"  -> 2/3 = 0.67
 * Both below 0.75, so an empty exclusion set drops nothing it should keep.
 *
 * LOWERING THE THRESHOLD COUPLES TO THIS. At 0.6 the second pair dies, and that
 * pair is a legitimate ladder rung. Anyone moving FILTER_DROP_JACCARD must
 * re-derive these numbers for the no-placeChain case first;
 * topic-similarity.test.ts pins both.
 */
export function placeExclusionSet(placeChain?: {
  neighbourhood?: string | null;
  locality?: string | null;
  admin1?: string | null;
  countryName?: string | null;
} | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!placeChain) return out;
  for (const field of [
    placeChain.neighbourhood,
    placeChain.locality,
    placeChain.admin1,
    placeChain.countryName,
  ]) {
    if (!field) continue;
    for (const word of field.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word) out.add(word);
    }
  }
  return out;
}

/** Jaccard over content words. Stopwords always excluded; place names excluded
 *  when the caller supplies a set (see placeExclusionSet). */
export function contentJaccard(
  a: string,
  b: string,
  exclude: ReadonlySet<string> = new Set(),
): number {
  const ta = tokenize(a, exclude);
  const tb = tokenize(b, exclude);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** The shared content words between two topics — what a drop collided ON, so a
 *  drop can be read and argued with rather than trusted. */
export function sharedTokens(
  a: string,
  b: string,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const tb = tokenize(b, exclude);
  return [...tokenize(a, exclude)].filter((t) => tb.has(t));
}

/**
 * True when a's content words are a subset of b's.
 *
 * The SCORER uses this; the FILTER must NOT. A ladder deliberately emits rungs
 * that contain each other ("Alkmaar hospital news" inside "Netherlands hospital
 * policy news"), so a subset rule in the filter eats the structure the skill
 * bodies exist to produce.
 */
export function isSubsetTopic(
  a: string,
  b: string,
  exclude: ReadonlySet<string> = new Set(),
): boolean {
  const ta = tokenize(a, exclude);
  const tb = tokenize(b, exclude);
  if (ta.size === 0 || tb.size === 0) return false;
  if (ta.size >= tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}
