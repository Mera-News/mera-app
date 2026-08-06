/**
 * Is this user-facing note actually ABOUT the article it sits on?
 *
 * WHY THIS EXISTS. Every reason-writing prompt already mandates the property
 * this module checks — "ONE plain sentence … containing (a) a specific detail
 * from the article — the event, entity, place, policy, or product, never 'this
 * topic'" (CLOUD_TWO_AXIS_BLOCK), and the legacy pass says it again ("if the
 * article is about holiday homes, the reason is about holiday homes"). Nothing
 * enforced it. Three separate mechanisms can put another article's sentence on a
 * row — a batch decode that zips results to articles by ARRAY POSITION, a
 * propagated donor reason copied verbatim onto a story sibling, and a model that
 * echoes one of the prompt's own worked examples instead of reading the article.
 * The first two are being fixed at their source; this is the backstop that holds
 * for ALL of them, including confabulation, which no index scheme can catch.
 *
 * THE BAR IS DELIBERATELY LOW: one shared content token. The asymmetry is the
 * point. Failing to drop a bad note costs us the status quo; dropping a GOOD
 * note costs the user an explanation they had earned, and the row falls back to
 * `reason_pending` where a sweep will spend another LLM call on it. So every
 * ambiguity resolves toward KEEP:
 *   - no article text to compare against ⇒ grounded (cannot judge, do not drop);
 *   - entities and geo tags count as article text, because a reason that names
 *     the place or org the tagger extracted IS grounded even when the headline
 *     phrased it differently;
 *   - plurals are folded, so "districts"/"district" and "rules"/"rule" match.
 * Only a reason with content of its own that shares NOTHING with the article is
 * rejected. On the case that motivated this — "New AI Act rules on deepfakes
 * directly impact your AI news app's compliance …" on an article titled "MP
 * Weather Update: 18% Less Rain in Madhya Pradesh, Drought-like Conditions in 49
 * Districts; IMD Alert for Next 3 Days" — the intersection is empty.
 *
 * SELF-CONTAINED TOKENIZER, ON PURPOSE. `lib/feed-grouping/story-grouping.ts`
 * has an equivalent `normalizeTitleTokens`, and this does NOT import it:
 * `lib/news-harness/**` imports nothing from app-land (that is what makes it
 * RN-free and runnable from `harness-local/`), and reaching into feed-grouping
 * would be the first breach. The duplication is ~20 lines and is the cheaper
 * side of that trade. The two lists may drift; they are used for different jobs
 * (Jaccard SIMILARITY between two headlines vs. an OVERLAP existence check) and
 * neither depends on the other's exact contents.
 */

/**
 * High-frequency English function words and headline filler. Only words that
 * carry no subject matter belong here — this list is applied to BOTH sides, so
 * anything added to it is a token that can no longer ground a reason. Keep it
 * conservative for that reason: over-stopping causes the expensive failure
 * (a good note dropped), not the cheap one.
 */
const GROUNDING_STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'our', 'out',
  'into', 'about', 'more', 'most', 'all', 'can', 'could', 'would', 'should',
  'than', 'then', 'when', 'what', 'who', 'how', 'why', 'where', 'while',
  'during', 'against', 'between', 'before', 'under', 'per', 'via', 'off',
  'from', 'after', 'amid', 'over', 'its', 'his', 'her', 'their', 'this',
  'that', 'has', 'have', 'new', 'says', 'said', 'was', 'were', 'been', 'they',
  'them', 'will', 'down', 'with',
]);

/**
 * Fold a trailing plural 's' so "districts" and "district" are one token.
 * Guarded at length > 3 so short words that merely END in 's' ("gas", "its")
 * survive intact. Applied to BOTH sides, so even a wrong fold ("press" →
 * "pres") still matches itself — the operation only has to be consistent, not
 * linguistically correct.
 */
function foldPlural(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

/**
 * Length at which two tokens sharing a leading run are treated as the same
 * word. See {@link isReasonGrounded} for why prefix matching exists at all.
 * Five is the measured floor: it unifies regulate/regulation and
 * legislate/legislation while keeping unrelated pairs apart, and shortening it
 * to four starts merging distinct words ("mine"/"mining" is fine, "part"/
 * "party" is not).
 */
const PREFIX_MATCH_LEN = 5;

/**
 * Non-alphanumerics to spaces → split → keep content tokens → lowercase → fold
 * plurals. Null/empty input yields an empty set. Never throws.
 *
 * TWO-CHARACTER TOKENS ARE KEPT ONLY WHEN THEY WERE UPPERCASE, which is how an
 * acronym is told apart from a function word without a second word list. This
 * matters more than it sounds: measured against the 292-article gold set, the
 * single largest cause of a good note being flagged was that "EU", "AI" and
 * "UK" — often the ONLY terms a note and its article share — were being dropped
 * by a blanket 3-character floor. "of"/"in"/"to" are lowercase in real prose and
 * still fall away. An all-caps headline can smuggle "IN"/"OF" past this; that
 * only ever makes the check more permissive, which is the safe direction.
 *
 * ASCII-only by design: both sides of this comparison are English. Notes are
 * always generated in English, and the article fields fed in are `title_en` /
 * `description_en`, the translated columns. The ORIGINAL-language title is
 * deliberately not used — it shares no tokens with an English note, so passing
 * it would only add noise.
 */
export function groundingTokens(text: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  // Case is preserved through the split so the acronym test below can run; each
  // token is lowercased only once it has been admitted.
  const cleaned = text.replace(/[^A-Za-z0-9]+/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length < 2) continue;
    if (raw.length === 2) {
      // An acronym or a number ("EU", "AI", "18"), not a function word.
      if (raw !== raw.toUpperCase()) continue;
    } else if (GROUNDING_STOPWORDS.has(raw.toLowerCase())) {
      continue;
    }
    tokens.add(foldPlural(raw.toLowerCase()));
  }
  return tokens;
}

/**
 * Do these two token sets share a word? Exact match first, then a shared
 * {@link PREFIX_MATCH_LEN}-character prefix, which is a deliberately crude
 * stand-in for stemming: a note explains an article in its own words, so
 * "regulate" in a headline becomes "regulation" in the sentence about it, and
 * an exact-match-only check reads that as a different subject entirely.
 */
function sharesAToken(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) return true;
  }
  // Index the larger set by prefix once rather than comparing every pair.
  const prefixes = new Set<string>();
  for (const token of large) {
    if (token.length >= PREFIX_MATCH_LEN) prefixes.add(token.slice(0, PREFIX_MATCH_LEN));
  }
  if (prefixes.size === 0) return false;
  for (const token of small) {
    if (token.length >= PREFIX_MATCH_LEN && prefixes.has(token.slice(0, PREFIX_MATCH_LEN))) {
      return true;
    }
  }
  return false;
}

/** The article side of the check. Every field is optional — callers pass what
 *  the row happens to carry, and absence never causes a rejection. */
export interface ReasonGroundingArticle {
  title?: string | null;
  description?: string | null;
  /** Server-tagged entities, already parsed out of `entities_json`. */
  entities?: string[] | null;
  /** Server-tagged place names, already parsed out of `geo_tags_json`. */
  geoTags?: string[] | null;
}

/**
 * Does `reason` share at least one content token with the article?
 *
 * Returns TRUE (grounded — keep the note) when:
 *   - the reason is empty or whitespace: there is nothing to police, and the
 *     callers already treat an empty reason as "no note owed";
 *   - the reason has no content tokens of its own after stopwording — it is
 *     contentless rather than wrong, and dropping it would change nothing a
 *     reader sees while costing a needless re-generation;
 *   - the article contributes no tokens at all (no title, no description, no
 *     tags): with nothing to compare against, a rejection would be a coin flip.
 *
 * Returns FALSE only when both sides have content and they share nothing.
 */
export function isReasonGrounded(
  reason: string | null | undefined,
  article: ReasonGroundingArticle,
): boolean {
  const reasonTokens = groundingTokens(reason);
  if (reasonTokens.size === 0) return true;

  const articleTokens = groundingTokens(
    [
      article.title ?? '',
      article.description ?? '',
      (article.entities ?? []).join(' '),
      (article.geoTags ?? []).join(' '),
    ].join(' '),
  );
  if (articleTokens.size === 0) return true;

  return sharesAToken(reasonTokens, articleTokens);
}
