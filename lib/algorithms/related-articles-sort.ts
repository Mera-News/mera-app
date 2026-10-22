/**
 * Ordering for the "Related Articles" list, run server-side by
 * `relatedArticlesPage` before the page is sliced.
 *
 * ============================================================================
 * THIS FILE IS ONE OF TWO COPIES. THEY MUST MOVE TOGETHER.
 *   server (canonical): mera-server/libs/mera-shared/src/related-sort/
 *   app:                mera-app/lib/algorithms/
 * See the banner in `geo-language-priority.ts` for why. The comments below are
 * the SPECIFICATION of this ordering, not commentary — they are what makes the
 * two copies checkable against each other. Do not trim them.
 * ============================================================================
 *
 * Pure functions only — no NestJS, no Mongoose, no config. It only depends on
 * the helpers in `geo-language-priority.ts`.
 *
 * `'relevance'` ("Best match") is one flat comparator. Each key only breaks the
 * ties the keys above it left:
 *
 *   1. Subscribed — the row's publication is in `subscribedPublications`.
 *   2. More from — the row's publication is in `preferredPublications`.
 *      Both lift a row whatever its language or country: a reader who
 *      subscribes to an outlet wants it first.
 *   3. Language — the user's app-language base first, then the other languages
 *      alphabetical by base code, then null/unknown last.
 *   4. `pubDateMs` DESC (newest first), undated last.
 *   5. `id` ASC (final deterministic tiebreak, which the id cursor relies on).
 *
 * Country takes no part in the order (owner decision): no country blocks, no
 * tier for the viewed article's country, no preferred-country scopes. Country
 * chips still FILTER the list; that happens before this runs.
 *
 * A `null` context leaves keys 1-3 inert, so the list is newest first. Old
 * apps send subscribed names inside `preferredPublications` only, so those rank
 * as More from. Never throws.
 */

import {
  baseLang,
  normPublicationName,
  type UserGeoLanguageContext,
} from './geo-language-priority';

/** The minimal shape a related-article entry must expose to be sortable. */
export interface RelatedSortable {
  /** Stable identity — the final deterministic tiebreak. */
  id: string;
  /** Article/publication language code (may be a full tag like `zh-Hans`). Null when unknown. */
  languageCode: string | null;
  /** Publishing country, ISO alpha-3. Null when unknown. Not an ordering key; the chip filters read it. */
  countryCodeAlpha3: string | null;
  /** Publication display name. Matched against the reader's publication tags. */
  publicationName: string | null;
  /** First-published time in epoch ms; higher = newer. NaN/null sorts as oldest. */
  pubDateMs: number | null;
}

/**
 * How `orderRelatedArticles` should order the list.
 *
 * - `'relevance'` (DEFAULT) — Subscribed → More from → language → date DESC →
 *   id, as in the module header. The only mode that consults the context.
 * - `'oldest'` — a FLAT publish-date ASCENDING sort.
 * - `'newest'` — the same flat sort, publish date DESCENDING.
 *
 * In BOTH date modes, rows with an unknown publish date (`null`/`NaN`) sort
 * LAST, not merely at the numeric extreme — so `'oldest'` is not the exact
 * reverse of `'newest'`. An undated row is not evidence of being early; putting
 * it at the head of "oldest first" would assert something the data does not say.
 * `id` ASC is the final tiebreak in every mode.
 */
export type RelatedSortMode = 'relevance' | 'oldest' | 'newest';

/** 0 = Subscribed, 1 = More from, 2 = neither. */
function publicationTierOf(item: RelatedSortable, ctx: UserGeoLanguageContext | null): number {
  const name = normPublicationName(item.publicationName);
  if (ctx === null || name === null) return 2;
  if (ctx.subscribedPublications?.has(name)) return 0;
  if (ctx.preferredPublications?.has(name)) return 1;
  return 2;
}

/**
 * Language key: group 0 = user's app language, 1 = another known language
 * (ordered alphabetical by base), 2 = null/unknown. `base` is the tiebreak
 * within group 1 only.
 */
function languageKey(
  item: RelatedSortable,
  ctx: UserGeoLanguageContext | null,
): { group: number; base: string } {
  // No context, no language preference: the list is plain newest-first.
  if (ctx === null) {
    return { group: 0, base: '' };
  }
  const base = baseLang(item.languageCode);
  if (base === null) {
    return { group: 2, base: '' };
  }
  if (ctx.appLanguageBase !== null && base === ctx.appLanguageBase) {
    return { group: 0, base };
  }
  return { group: 1, base };
}

/**
 * Publish-date ordering, undated rows last in BOTH directions (see
 * `RelatedSortMode`), then `id` ASC.
 */
function compareByDate(a: RelatedSortable, b: RelatedSortable, ascending: boolean): number {
  const da = a.pubDateMs;
  const db = b.pubDateMs;
  const ua = da === null || da === undefined || Number.isNaN(da);
  const ub = db === null || db === undefined || Number.isNaN(db);
  if (ua !== ub) return ua ? 1 : -1; // undated last, either direction
  if (!ua && !ub && da !== db) {
    return ascending ? da - db : db - da;
  }
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Return a NEW array of `items` ordered according to `mode`. Non-mutating,
 * deterministic for a given input, never throws.
 */
export function orderRelatedArticles<T extends RelatedSortable>(
  items: T[],
  ctx: UserGeoLanguageContext | null,
  mode: RelatedSortMode = 'relevance',
): T[] {
  if (mode === 'oldest' || mode === 'newest') {
    return [...items].sort((a, b) => compareByDate(a, b, mode === 'oldest'));
  }

  return [...items].sort((a, b) => {
    const ta = publicationTierOf(a, ctx);
    const tb = publicationTierOf(b, ctx);
    if (ta !== tb) return ta - tb;

    const la = languageKey(a, ctx);
    const lb = languageKey(b, ctx);
    if (la.group !== lb.group) return la.group - lb.group;
    if (la.group === 1 && la.base !== lb.base) {
      return la.base < lb.base ? -1 : 1;
    }

    return compareByDate(a, b, false);
  });
}
