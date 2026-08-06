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
 * Lowercase → non-alphanumerics to spaces → split → keep tokens longer than 2
 * → drop stopwords → fold plurals. Null/empty input yields an empty set.
 * Never throws.
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
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length > 2 && !GROUNDING_STOPWORDS.has(raw)) {
      tokens.add(foldPlural(raw));
    }
  }
  return tokens;
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

  // Iterate the smaller set — groups are small, but this is called once per
  // persisted reason and the cost is otherwise proportional to description
  // length.
  const [small, large] =
    reasonTokens.size <= articleTokens.size
      ? [reasonTokens, articleTokens]
      : [articleTokens, reasonTokens];
  for (const token of small) {
    if (large.has(token)) return true;
  }
  return false;
}
