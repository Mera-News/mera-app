// reading-stats — the pure aggregation core behind the Mera Stats share card.
//
// Pure and total: no react-native, expo, watermelondb, zustand, logger or
// database import at runtime (the two `import type` lines below erase), and no
// clock read — `nowMs` is always injected so a rendered card is a pure function
// of its inputs. The WatermelonDB side lives in `reading-stats-source.ts`, which
// holds no logic.
//
// Everything here is computed from data the app ALREADY keeps to operate:
// `publication_visits` runs the Sources tab and `story_impressions` runs feed
// dedup and the read-story filter. Nothing new is recorded for this card, and
// nothing may be: hard invariant 9 forbids behavioural instrumentation outright.
// That is also why the card shows four figures rather than the seven the
// original plan sketched — articles read as a true total, average reading time,
// the skim-versus-read split and articles shared each need a recording that does
// not exist and may not be added.
//
// ## Two windows, and why they are not reconciled
//
// Countries, publications, opened and publish-to-read are all 30-day. Saved and
// followed are PRESENT TENSE and live in `keptNow` for exactly that reason:
// both tables carry a timestamp that would let them be windowed, and windowing
// them would produce a figure nobody asks for. "Articles you saved in the last
// 30 days and have not since removed" is not a fact about reading, it is an
// artefact of intersecting two unrelated rules. So the split is carried in the
// TYPE and each surface states one window rather than averaging them into a
// heading that is true of neither.
//
// ## There is no "articles analysed by AI" figure, and there cannot be
//
// Not a policy refusal, an absence. No device-local record of it exists: the
// closest thing, `article_suggestions.relevance_generation_completed`, is a
// genuine per-article record that the scoring pass ran, but its table is swept
// at 48h, so a 30-day tally is unrecoverable and even a 48-hour one undercounts
// by every row already swept. See `reading-stats-source.ts` for the other six
// candidates and why each fails. The app keeps no running tally of its own work
// because nothing in the product needs one to function.
//
// Three labelling rules are encoded in the SHAPE of what this returns, so a
// caller cannot render an honest-looking number without its caveat:
//
//   1. The 30-day ceiling is real. `WINDOW_DAYS` is not cosmetic — both inputs
//      are filtered to it here.
//   2. `publishToRead` always carries `sampledArticles` and `totalArticles`
//      alongside the average, because `pub_date` is optional and only populated
//      from schema v23 onward. A bare average over the covered subset presented
//      as the whole is the specific bug that rule exists to prevent.
//   3. `articlesOpened` is PARTIAL and named so. It counts suggestion-card taps
//      only: `use-open-article.ts` deliberately does not call `recordOpen`,
//      because an impression evicts the story from the Dashboard, so Explore,
//      search and detail opens are invisible BY DESIGN. Widening the count by
//      changing that would trade feed behaviour for a vanity number.

import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import { computePublishToReadStats, type PublishToReadStats } from '@/lib/reading-history-export';

/** Mirrors `DEFAULT_WINDOW_MS` in publication-visit-service.ts. The visits query
 *  already enforces it; impressions do NOT (see `StatsImpression`), so this
 *  module applies it to both rather than trusting either. */
export const WINDOW_DAYS = 30;
export const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * One `story_impressions` row, flattened.
 *
 * `story_impressions` does NOT enforce its 30-day TTL at query level the way
 * `publication_visits` does: the table is pruned by `deleteOlderThan` from
 * data-cleanup-task, so between sweeps `getAll()` can return rows older than the
 * window. A "last 30 days" label over an unfiltered impression read would be a
 * false claim whenever that sweep is behind, which is why `computeReadingStats`
 * filters on `firstSeenAtMs` itself.
 */
export interface StatsImpression {
  articleId: string;
  opened: boolean;
  /** Epoch ms, or null for a partially-written or unparseable row. */
  firstSeenAtMs: number | null;
}

/** One row of the opt-in "top publications" list. Name plus country only —
 *  article titles are never included under any setting. */
export interface TopPublication {
  publicationName: string;
  countryCode: string | null;
  /** Total taps on this publication's articles inside the window. */
  visitCount: number;
}

/**
 * One country the reader has seen news from, inside the window, with how many
 * taps it accounted for.
 *
 * The COUNT is what makes the proportion bar on the reach card honest: shares
 * are computed from these, not from the number of publications, so a country
 * with one prolific publisher is not flattened to the same width as one with
 * six occasional ones.
 */
export interface CountryShare {
  countryCode: string;
  /** Total taps on this country's articles inside the window. */
  visitCount: number;
}

/**
 * The two figures that are NOT windowed, kept in their own object so a caller
 * cannot render them under a "last 30 days" heading by accident.
 *
 * This is the same trick `publishToRead` plays with its coverage denominator:
 * the SHAPE carries the labelling rule, so the rule cannot be forgotten at a
 * render site. Both are present tense by nature. "Saved" and "following" are
 * states the reader is in right now, not events inside a window, and
 * `saved_at` / `created_at` would let either be windowed but the result would
 * answer a question nobody asks: "articles you saved in the last 30 days and
 * have not since removed" is not a fact about reading, it is an artefact of
 * intersecting two unrelated rules.
 */
export interface KeptNow {
  /** Rows in `saved_article_suggestions` that are real user saves. Retention
   *  rows (`origin` 'fact_check' or 'tracked_story') are excluded upstream by
   *  `loadSavedItems`, so a followed story's members never inflate this and
   *  never double-count against `followedStories`. */
  savedArticles: number;
  /** `tracked_stories` rows with `status = 'active'`. Unfollowing hard-deletes
   *  the row, so there is no tombstone to over-count. */
  followedStories: number;
}

export interface ReadingStats {
  /** Stated on the card. The card can never show more than this. */
  windowDays: number;
  /** Distinct publication names visited inside the window. */
  publicationCount: number;
  /** Distinct country codes visited inside the window. */
  countryCount: number;
  /**
   * Every country visited inside the window, most-visited first, then by code
   * for a stable tie-break. `countryCount` is exactly its length.
   *
   * The full list, not a top-N: the reach card draws a flag for each and caps
   * the GRID, which is a layout decision that belongs at the render site where
   * the available width is known. Capping here would silently decide it for
   * every future surface.
   */
  countries: CountryShare[];
  /**
   * Distinct articles OPENED inside the window. Partial by construction — see
   * the module header. Never label this "articles read".
   */
  articlesOpened: number;
  /** Publish-to-read LATENCY, with its coverage denominator. This is not
   *  reading duration and must never be labelled as one; no duration
   *  instrumentation exists anywhere in the app. */
  publishToRead: PublishToReadStats;
  /** Sorted by visitCount desc, then name asc for a stable tie-break. Only
   *  rendered when the naming opt-in is on. */
  topPublications: TopPublication[];
  /** NOT windowed. See `KeptNow` for why, before rendering it under a heading
   *  that mentions 30 days. */
  keptNow: KeptNow;
  /**
   * False when there is nothing worth sharing, so the caller shows an empty
   * state instead of a card full of zeroes.
   *
   * Keyed on VISITS ALONE, deliberately. Three of the card's four figures
   * (publications, countries, publish-to-read latency) come from
   * `publication_visits`, so a device with impressions but no visits has one
   * number and three blanks, which is not a card. It also makes Settings then
   * Manage Data then "Clear viewing history" visibly work: that action calls
   * `clearAllVisits()` and wipes ONLY `publication_visits`, so keying on
   * impressions too left the screen showing a numeric card after a clear that
   * had promised to empty it.
   *
   * `story_impressions` is deliberately NOT cleared by that action and must not
   * be: it runs feed dedup and the read-story filter, so wiping it would
   * resurrect already-read stories in the feed. Trading feed behaviour for a
   * share-card number is the same mistake the plan forbids around
   * `use-open-article.ts`. The residual is small and documented: right after a
   * clear, the first new visit brings the card back with an `articlesOpened`
   * that still counts pre-clear taps. The figure is labelled partial on the
   * card, which is exactly the claim that stays true.
   */
  hasAnyData: boolean;
}

export interface ComputeReadingStatsInput {
  /** From `getAllVisitedArticles()` — already deduped per article and already
   *  windowed at query level; re-filtered here so the core is correct on any
   *  input, including a test fixture or a future wider query. */
  visits: VisitedArticle[];
  /** From `getAll()` on story-impression-service, flattened. */
  impressions: StatsImpression[];
  /** Reference "now", epoch ms. INJECTED, never read from the clock here. */
  nowMs: number;
  /** How many rows the opt-in list may show. */
  topPublicationLimit?: number;
  /**
   * Present-tense counts, passed in rather than derived here because they come
   * from tables this module deliberately does not import. Both default to 0 so
   * an existing caller keeps working and gets an honest zero rather than a
   * wrong number.
   */
  keptNow?: Partial<KeptNow>;
}

const DEFAULT_TOP_PUBLICATION_LIMIT = 3;

/** A visit row's tap count, floored at 1. A row that exists was visited at
 *  least once, whatever a malformed `visit_count` says. */
function tapsOf(visit: VisitedArticle): number {
  return Number.isFinite(visit.visitCount) && visit.visitCount > 0 ? visit.visitCount : 1;
}

function cleaned(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The whole card, from rows to figures. Total: zero visits, zero impressions and
 * zero rows with a known publish time all return cleanly, and there is no
 * division anywhere that is not guarded by its own count.
 */
export function computeReadingStats({
  visits,
  impressions,
  nowMs,
  topPublicationLimit = DEFAULT_TOP_PUBLICATION_LIMIT,
  keptNow,
}: ComputeReadingStatsInput): ReadingStats {
  const cutoff = nowMs - WINDOW_MS;

  // A visit in the FUTURE (a clock change, or a row written by a device whose
  // time was wrong) is kept rather than dropped: it is inside the window by any
  // reading, and dropping it would silently narrow a count the user can see
  // elsewhere in the Sources tab.
  const windowedVisits = visits.filter((v) => Number.isFinite(v.visitedAt) && v.visitedAt >= cutoff);

  const publications = new Set<string>();
  // Keyed by code so the reach card can weight its proportion bar by taps.
  // A Set would have answered `countryCount` and nothing else.
  const byCountry = new Map<string, CountryShare>();
  const byPublication = new Map<string, TopPublication>();

  for (const visit of windowedVisits) {
    const name = cleaned(visit.publicationName);
    const country = cleaned(visit.countryCode);
    // Counted BEFORE the name guard, deliberately. A visit with a country but
    // no publication name is still a country the reader saw news from, and
    // dropping it would make the flag grid disagree with the Sources tab.
    if (country) {
      const taps = tapsOf(visit);
      const seen = byCountry.get(country);
      if (seen) seen.visitCount += taps;
      else byCountry.set(country, { countryCode: country, visitCount: taps });
    }
    if (!name) continue;

    publications.add(name);
    // Keyed on name AND country: the visits table itself is keyed that way,
    // because two publishers can share a name across markets.
    const key = `${name} ${country ?? ''}`;
    const taps = tapsOf(visit);
    const existing = byPublication.get(key);
    if (existing) {
      existing.visitCount += taps;
    } else {
      byPublication.set(key, { publicationName: name, countryCode: country, visitCount: taps });
    }
  }

  // Most-visited first, then by code: `localeCompare` on a country CODE is a
  // stable tie-break and never reaches the user as text, so it needs no locale.
  const countries = [...byCountry.values()].sort((a, b) => {
    if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
    return a.countryCode.localeCompare(b.countryCode);
  });

  const topPublications = [...byPublication.values()]
    .sort((a, b) => {
      if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
      return a.publicationName.localeCompare(b.publicationName);
    })
    .slice(0, Math.max(0, topPublicationLimit));

  // Opened only, inside the window, deduped by article id. A row with no
  // parseable `first_seen_at` cannot be placed in the window and is dropped:
  // counting it would be exactly the "last 30 days" overclaim this guards.
  const openedArticleIds = new Set<string>();
  for (const impression of impressions) {
    if (impression.opened !== true) continue;
    if (impression.firstSeenAtMs === null || !Number.isFinite(impression.firstSeenAtMs)) continue;
    if (impression.firstSeenAtMs < cutoff) continue;
    const id = cleaned(impression.articleId);
    if (id) openedArticleIds.add(id);
  }

  // Reused rather than reimplemented — this is the same quantity the reading
  // history export reports, and a second implementation would be free to drift
  // into calling it something it is not.
  const publishToRead = computePublishToReadStats(windowedVisits);

  return {
    windowDays: WINDOW_DAYS,
    publicationCount: publications.size,
    countryCount: countries.length,
    countries,
    articlesOpened: openedArticleIds.size,
    publishToRead,
    topPublications,
    keptNow: {
      savedArticles: nonNegative(keptNow?.savedArticles),
      followedStories: nonNegative(keptNow?.followedStories),
    },
    hasAnyData: publications.size > 0,
  };
}

/** A count that is always a whole number at or above zero, whatever arrived. */
function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

/** The shape `computeReadingStats` returns for an empty device. Exported so the
 *  preview screen has something to render before the first read resolves,
 *  rather than branching on null. */
export function emptyReadingStats(): ReadingStats {
  return {
    windowDays: WINDOW_DAYS,
    publicationCount: 0,
    countryCount: 0,
    countries: [],
    articlesOpened: 0,
    publishToRead: { averageHours: null, sampledArticles: 0, totalArticles: 0 },
    topPublications: [],
    keptNow: { savedArticles: 0, followedStories: 0 },
    hasAnyData: false,
  };
}

/**
 * Rounds the latency average for display. Returns null when there is no average,
 * which is NOT the same as zero: zero would read as "instant", and the card must
 * say "not enough data" instead.
 */
export function roundedAverageHours(stats: PublishToReadStats): number | null {
  if (stats.averageHours === null) return null;
  return Math.max(0, Math.round(stats.averageHours));
}


// --- per-card availability -------------------------------------------------

/**
 * The three share cards, by theme. Breadth, intent, reading.
 *
 * The ids are stable and reach the deep link as a param, so renaming one is a
 * URL change, not a refactor.
 */
export const STATS_CARD_IDS = ['reach', 'keep', 'pace'] as const;
export type StatsCardId = (typeof STATS_CARD_IDS)[number];

/** The card the share route falls back to when it is opened with no param, as
 *  the existing `com.mera.news://logged-in/share-stats` link always is. */
export const DEFAULT_STATS_CARD: StatsCardId = 'reach';

/**
 * Does this card have anything on it?
 *
 * Per card rather than per screen, because the three draw on different tables
 * and `hasAnyData` cannot answer for all of them. A reader who has saved
 * articles but cleared their viewing history has a real `keep` card and an
 * empty `reach` one, and offering a card of zeroes is worse than not offering
 * it. `hasAnyData` stays what it was, the SCREEN-level gate keyed on visits
 * alone, so Settings then Manage Data then Clear viewing history still visibly
 * empties the surface it promised to empty.
 */
export function cardHasData(stats: ReadingStats, card: StatsCardId): boolean {
  switch (card) {
    case 'reach':
      return stats.countries.length > 0 || stats.publicationCount > 0;
    case 'keep':
      return stats.keptNow.savedArticles > 0 || stats.keptNow.followedStories > 0;
    case 'pace':
      return stats.articlesOpened > 0 || stats.publishToRead.averageHours !== null;
  }
}

/** The cards worth offering, in theme order. Empty for an empty device. */
export function availableCards(stats: ReadingStats): StatsCardId[] {
  return STATS_CARD_IDS.filter((card) => cardHasData(stats, card));
}

/**
 * The reach card's proportion bar: the largest `topN` countries by taps, plus
 * one remainder segment when anything is left over.
 *
 * Shares are fractions of the WINDOWED TOTAL, so they always sum to 1 and the
 * bar can never leave a gap it does not explain. Returned as fractions rather
 * than percentages because rounding for display is the render site's business,
 * and rounding here would let three rounded values sum to 99.
 */
export interface CountryBand {
  /** Null on the remainder band, which has no single country. */
  countryCode: string | null;
  share: number;
}

export function countryBands(stats: ReadingStats, topN = 3): CountryBand[] {
  const total = stats.countries.reduce((sum, c) => sum + c.visitCount, 0);
  if (total <= 0) return [];

  const lead = stats.countries.slice(0, Math.max(0, topN));
  const bands: CountryBand[] = lead.map((c) => ({
    countryCode: c.countryCode,
    share: c.visitCount / total,
  }));

  const leadTotal = lead.reduce((sum, c) => sum + c.visitCount, 0);
  // Strictly greater, so a rounding residue of zero never draws a band the
  // reader cannot see and the legend never names an empty "rest".
  if (total - leadTotal > 0) {
    bands.push({ countryCode: null, share: (total - leadTotal) / total });
  }
  return bands;
}

/**
 * Which card a share deep link should open, given whatever arrived in the URL.
 *
 * `com.mera.news://logged-in/share-stats` ships with NO param and must keep
 * working, so a missing param is the ordinary case rather than an error. A
 * param that is present but not a known id is treated identically: a URL is
 * untrusted input, its TypeScript type is a claim about nothing, and the only
 * safe reading of `?card=foo` is that the caller did not name a card.
 *
 * A valid id for a card with nothing on it also falls through, because landing
 * a share link on an empty card is the same dead end as landing on a crash,
 * only quieter. Returns null when the device has no card at all, which is the
 * screen's cue to show its empty state rather than an empty card.
 */
export function resolveStatsCardParam(
  raw: unknown,
  stats: ReadingStats,
): StatsCardId | null {
  const available = availableCards(stats);
  if (available.length === 0) return null;

  const asked = typeof raw === 'string' ? raw : undefined;
  const named = STATS_CARD_IDS.find((id) => id === asked);
  if (named && available.includes(named)) return named;

  // The default first, so the shipped no-param link lands where it always did
  // whenever that card has anything on it.
  if (available.includes(DEFAULT_STATS_CARD)) return DEFAULT_STATS_CARD;
  return available[0];
}
