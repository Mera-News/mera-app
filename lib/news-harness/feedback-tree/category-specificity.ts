// Is an article's category DISCRIMINATING enough to become a structured filter?
// PURE, RN-FREE.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// D10 promoted "not important → this category" from a keyword substring scan to
// a structured `kind: 'category'` filter — an EXACT match on the article's
// category field. That is the right semantics ("this category" should mean the
// category), but the app's `category` is not the article's own topic label: it
// is the PUBLICATION SOURCE's category (see the GraphQL DTO comment on
// `articles-for-topics.dto.ts` — "the PUBLICATION SOURCE's category …, NOT the
// article's own `category` field"). Most of that catalogue is one generic
// bucket, so an exact match on it is not "this category" at all — it is "most
// of the feed".
//
// Measured against prod `publication-source` on 2026-07-29:
//   3475 sources carry a category, across 570 DISTINCT values.
//   2567 of them (73.9%) sit on the generic "news" family; only 908 (26.1%)
//   carry something discriminating.
//   Heaviest values: News 1246 · general_news 948 · News (French) 67 ·
//   News (English) 47 · News (Arabic) 39 · News (English, Pidgin) 11 …
//   against Business 52 · Sports 18 · Tech 14 · Technology 12 · Science 11 ·
//   Cricket 10 · Programming 10 · News-family variants in the single digits.
//
// One tap on a mainstream story would therefore have soft-penalised every
// article from ~74% of the catalogue, invisibly, from a gesture the user thinks
// is about ONE story — and 30 days later they cannot connect a flat feed to
// that tap.
//
// ── A generic category mints NOTHING (not a keyword fallback) ───────────────
// The first cut of this gate degraded a generic category to a KEYWORD filter,
// and QA caught it (F4): tapping "This category" on a "News"-category article
// produced an Activity entry `Suppressed: News` and a filter row literally
// labelled "News". That is strictly worse than the structured filter being
// refused — `keyword` is a normalized SUBSTRING scan over title + description +
// entities, so the filter latches onto arbitrary stories that merely mention
// the word, with no relation to what the user meant.
//
// The two failure modes need different answers and must not share one:
//   • PROVENANCE — we cannot prove the value is the article's own field.
//     Keyword is right: narrower than claimed, but honest, and it fires.
//   • GENERICNESS — the value IS the article's field, and is simply useless.
//     Mint nothing; `isInertActionLeaf` then hides the option on that article.
//
// ── The rule ────────────────────────────────────────────────────────────────
// The STEM does the generalizing, not the word list. Stemming collapses the
// whole observed generic family — "News", "general_news", and every
// "News (French)" / "News (English, Pidgin)" language variant — onto two stems,
// so the constant list stays two entries while covering 60+ catalogue values
// and any future language variant automatically.
//
// Deliberately NOT gated on a share-of-catalogue threshold: the client never
// sees the publication catalogue, only the one category on the article in hand.
//
// Re-check the distribution with:
//   db.getCollection('publication-source').aggregate([
//     { $match: { category: { $type: 'string' } } },
//     { $project: { generic: { $regexMatch: {
//         input: '$category',
//         regex: '^\\s*(news|general[ _-]?news|general)\\s*($|[(\\[])',
//         options: 'i' } } } },
//     { $group: { _id: '$generic', n: { $sum: 1 } } },
//   ])
// If the generic share has dropped a lot (the tagging pipeline starting to
// write a real article-level `category` would do it), this gate can be removed
// and every category becomes structurable again.

/** Category stems that name no subject — an exact match on one of these hits
 *  most of the feed, so it can never be a structured filter. Two entries by
 *  design: `categoryStem` folds the whole observed family onto them. */
const GENERIC_CATEGORY_STEMS: ReadonlySet<string> = new Set(['news', 'general news']);

/**
 * Reduce a raw category to its comparable stem:
 *   - lowercase;
 *   - drop any parenthetical/bracketed qualifier and everything after it, so
 *     every "News (…)" language variant folds onto "news";
 *   - separators (`_`, `-`, `/`) become spaces, so "general_news" → "general news";
 *   - collapse and trim whitespace.
 *
 * Note this does NOT strip a colon: "Regional News: Kolkata" stems to
 * "regional news: kolkata" and stays discriminating, which is correct — it
 * names a region and covers a single source.
 */
export function categoryStem(category: string | null | undefined): string {
  return (category ?? '')
    .toLowerCase()
    .replace(/[([{].*$/, ' ')
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a category filter on this value is a promise we can keep. False for
 * an empty value and for the generic "news" family.
 *
 * A false here means the caller must mint NOTHING — NOT a keyword filter on the
 * same text (see the F4 note in the header). The option then hides itself,
 * because `isInertActionLeaf` drops an action leaf that resolves to no actions.
 */
export function isDiscriminatingCategory(category: string | null | undefined): boolean {
  const stem = categoryStem(category);
  return stem.length > 0 && !GENERIC_CATEGORY_STEMS.has(stem);
}
