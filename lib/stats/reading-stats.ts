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
/**
 * One language the reader read articles in, inside the window.
 *
 * A DIFFERENT fact from country, not a proxy for it: one publisher in
 * Switzerland produces German, French and Italian rows, and that difference is
 * the whole point of the metric. `language_code` is optional on the row, so
 * rows without one are counted nowhere rather than bucketed as "unknown" —
 * an unknown bucket in a proportion bar is a segment the reader cannot act on.
 */
export interface LanguageShare {
  languageCode: string;
  visitCount: number;
}

/**
 * One day, and how many articles the reader read on it.
 *
 * `dateKey` is a LOCAL calendar date (YYYY-MM-DD in the device's timezone),
 * never UTC. Same reasoning as the daily cap copy: a UTC date is simply the
 * wrong day for a large share of readers, and this one is rendered as a grid
 * cell the reader will check against their own memory of yesterday.
 *
 * NOT "days you opened the app". There is no app-open record, no session row
 * and no launch counter anywhere in the schema, and there must not be one. What
 * this counts is articles read, from visit rows the app already keeps to run
 * the Sources tab. Labelling it "opened" would be false AND would invite the
 * next person to add session tracking to make it true, which is exactly the
 * instrumentation hard invariant 9 forbids.
 */
export interface DayRead {
  dateKey: string;
  /** Distinct articles visited that day. Zero for a day with no reading. */
  count: number;
  /** 0 = Monday .. 6 = Sunday. Precomputed so the grid can align its first row
   *  to a weekday column without re-parsing the key at the render site. */
  weekday: number;
}

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
  /** Every language read in inside the window, most-read first. */
  languages: LanguageShare[];
  /** Distinct language codes inside the window. Exactly `languages.length`. */
  languageCount: number;
  /**
   * One entry per day of the window, oldest first, INCLUDING days with no
   * reading. A caller drawing a calendar grid needs the zeros to be present:
   * skipping them would silently close the gaps and turn a patchy month into a
   * solid one, which is the one thing this visual must not do.
   */
  days: DayRead[];
  /** Days in `days` with a count above zero. */
  daysReadCount: number;
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
  const byLanguage = new Map<string, LanguageShare>();
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
    const language = cleaned(visit.languageCode);
    if (language) {
      const taps = tapsOf(visit);
      const seen = byLanguage.get(language);
      if (seen) seen.visitCount += taps;
      else byLanguage.set(language, { languageCode: language, visitCount: taps });
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

  const languages = [...byLanguage.values()].sort((a, b) => {
    if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
    return a.languageCode.localeCompare(b.languageCode);
  });

  const days = dailyReads(windowedVisits, nowMs);

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
    languages,
    languageCount: languages.length,
    days,
    daysReadCount: days.filter((d) => d.count > 0).length,
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
    languages: [],
    languageCount: 0,
    days: [],
    daysReadCount: 0,
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
 * The three share cards, one window each.
 *
 *   reach  (last 30 days) where the reading came from: countries, publications,
 *          languages, top publications
 *   habits (last 30 days) how the reading went: days read, articles opened,
 *          publish-to-read time
 *   keep   (right now)    what is still held: saved articles, followed stories
 *
 * There were five, one idea each, and most of each card was empty space. They
 * were merged along the WINDOW line, never across it: saved and followed are
 * present tense and cannot sit under a 30-day heading, so keep stays its own
 * card rather than joining habits.
 *
 * The ids reach the deep link as a param, so renaming one is a URL change.
 * The retired ids resolve through `LEGACY_STATS_CARD_IDS` so an old link still
 * lands on the card that now carries what it named.
 */
export const STATS_CARD_IDS = ['reach', 'habits', 'keep'] as const;
export type StatsCardId = (typeof STATS_CARD_IDS)[number];

/** Retired card ids, mapped to the card that now holds their figures. */
export const LEGACY_STATS_CARD_IDS: Readonly<Record<string, StatsCardId>> = {
  languages: 'reach',
  pace: 'habits',
  rhythm: 'habits',
};

/** The card the share route falls back to when it is opened with no param, as
 *  the existing `com.mera.news://logged-in/share-stats` link always is. */
export const DEFAULT_STATS_CARD: StatsCardId = 'reach';

/**
 * Does this card have anything on it?
 *
 * Per card rather than per screen, because the cards draw on different tables
 * and `hasAnyData` cannot answer for all of them. A reader who has saved
 * articles but cleared their viewing history has a real `keep` card and an
 * empty `reach` one, and offering a card of zeroes is worse than not offering
 * it. `hasAnyData` stays what it was, the SCREEN-level gate keyed on visits
 * alone, so Settings then Manage Data then Clear viewing history still visibly
 * empties the surface it promised to empty.
 *
 * Inside a card, each figure with nothing to show is hidden rather than drawn
 * as a zero; the card itself is offered when ANY of its figures has data.
 */
export function cardHasData(stats: ReadingStats, card: StatsCardId): boolean {
  switch (card) {
    case 'reach':
      return (
        stats.countries.length > 0 || stats.publicationCount > 0 || stats.languages.length > 0
      );
    case 'habits':
      // Days are keyed on a day actually READ, not on the calendar existing:
      // the grid is always 30 cells long, so `days.length` is never zero for a
      // device with a clock and would offer a card of empty squares to everyone.
      return (
        stats.daysReadCount > 0
        || stats.articlesOpened > 0
        || stats.publishToRead.averageHours !== null
      );
    case 'keep':
      return stats.keptNow.savedArticles > 0 || stats.keptNow.followedStories > 0;
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
  const named =
    STATS_CARD_IDS.find((id) => id === asked)
    ?? (asked !== undefined && Object.prototype.hasOwnProperty.call(LEGACY_STATS_CARD_IDS, asked)
      ? LEGACY_STATS_CARD_IDS[asked]
      : undefined);
  if (named && available.includes(named)) return named;

  // The default first, so the shipped no-param link lands where it always did
  // whenever that card has anything on it.
  if (available.includes(DEFAULT_STATS_CARD)) return DEFAULT_STATS_CARD;
  return available[0];
}

// --- daily reading, for the rhythm grid ------------------------------------

/**
 * A LOCAL calendar date key, `YYYY-MM-DD`, in the device's own timezone.
 *
 * `en-CA` is the shortest way to get ISO order out of the platform's own date
 * formatter, which is what makes this timezone-correct without composing the
 * string by hand or reaching for `toISOString` (which is UTC and would put a
 * late-evening read on tomorrow for every reader east of Greenwich, and an
 * early-morning one on yesterday for every reader west of it).
 */
export function localDateKey(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 0 = Monday .. 6 = Sunday. The week starts on Monday because the grid's
 *  point is that a reader can SEE their weekends, and a Sunday-first week puts
 *  the two weekend days at opposite ends of the row. */
export function mondayIndex(ms: number): number {
  return (new Date(ms).getDay() + 6) % 7;
}

/**
 * One entry per day of the window, oldest first, zeros included.
 *
 * Counts DISTINCT ARTICLES per day. `getAllVisitedArticles` already dedupes a
 * repeated visit to the same article into one row carrying a `visitCount`, so
 * one row is one article and the row count per day is the article count. Using
 * `visitCount` here instead would count re-opens and turn "articles you read
 * that day" into "times you tapped", a different and less honest claim.
 */
export function dailyReads(
  windowedVisits: VisitedArticle[],
  nowMs: number,
  days: number = WINDOW_DAYS,
): DayRead[] {
  const counts = new Map<string, number>();
  for (const visit of windowedVisits) {
    if (!Number.isFinite(visit.visitedAt)) continue;
    const key = localDateKey(visit.visitedAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Walked back from today one calendar day at a time rather than by
  // subtracting 86_400_000, because a DST boundary makes a local day 23 or 25
  // hours long and fixed-millisecond arithmetic silently drops or repeats a day
  // twice a year.
  const out: DayRead[] = [];
  const cursor = new Date(nowMs);
  cursor.setHours(12, 0, 0, 0); // midday, so a DST shift cannot cross midnight
  for (let i = 0; i < days; i += 1) {
    const ms = cursor.getTime();
    out.push({ dateKey: localDateKey(ms), count: counts.get(localDateKey(ms)) ?? 0, weekday: mondayIndex(ms) });
    cursor.setDate(cursor.getDate() - 1);
  }
  return out.reverse();
}

/**
 * How many rows a 7-column grid needs for these days.
 *
 * The first row is PADDED so day one lands in its own weekday column, so the
 * row count is not `days / 7`: a 30-day window starting on a Saturday needs SIX
 * rows, not five. Exported because the height budget has to model the worst
 * case the UI can be asked to draw, and five rows is the lucky case.
 */
export function heatGridRows(days: DayRead[]): number {
  if (days.length === 0) return 0;
  return Math.ceil((days[0].weekday + days.length) / 7);
}

/** The most articles read on any one day, which is what the shading scale is
 *  normalised against. Returns 0 for an empty or all-zero window, and callers
 *  must treat 0 as "draw every cell at the empty tone" rather than dividing. */
export function peakDayCount(days: DayRead[]): number {
  return days.reduce((max, d) => Math.max(max, d.count), 0);
}
