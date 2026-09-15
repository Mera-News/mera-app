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

export interface ReadingStats {
  /** Stated on the card. The card can never show more than this. */
  windowDays: number;
  /** Distinct publication names visited inside the window. */
  publicationCount: number;
  /** Distinct country codes visited inside the window. */
  countryCount: number;
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
  /** False when there is nothing worth sharing, so the caller can show an empty
   *  state instead of a card full of zeroes. */
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
}

const DEFAULT_TOP_PUBLICATION_LIMIT = 3;

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
}: ComputeReadingStatsInput): ReadingStats {
  const cutoff = nowMs - WINDOW_MS;

  // A visit in the FUTURE (a clock change, or a row written by a device whose
  // time was wrong) is kept rather than dropped: it is inside the window by any
  // reading, and dropping it would silently narrow a count the user can see
  // elsewhere in the Sources tab.
  const windowedVisits = visits.filter((v) => Number.isFinite(v.visitedAt) && v.visitedAt >= cutoff);

  const publications = new Set<string>();
  const countries = new Set<string>();
  const byPublication = new Map<string, TopPublication>();

  for (const visit of windowedVisits) {
    const name = cleaned(visit.publicationName);
    const country = cleaned(visit.countryCode);
    if (country) countries.add(country);
    if (!name) continue;

    publications.add(name);
    // Keyed on name AND country: the visits table itself is keyed that way,
    // because two publishers can share a name across markets.
    const key = `${name} ${country ?? ''}`;
    const taps = Number.isFinite(visit.visitCount) && visit.visitCount > 0 ? visit.visitCount : 1;
    const existing = byPublication.get(key);
    if (existing) {
      existing.visitCount += taps;
    } else {
      byPublication.set(key, { publicationName: name, countryCode: country, visitCount: taps });
    }
  }

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
    countryCount: countries.size,
    articlesOpened: openedArticleIds.size,
    publishToRead,
    topPublications,
    hasAnyData: publications.size > 0 || openedArticleIds.size > 0,
  };
}

/** The shape `computeReadingStats` returns for an empty device. Exported so the
 *  preview screen has something to render before the first read resolves,
 *  rather than branching on null. */
export function emptyReadingStats(): ReadingStats {
  return {
    windowDays: WINDOW_DAYS,
    publicationCount: 0,
    countryCount: 0,
    articlesOpened: 0,
    publishToRead: { averageHours: null, sampledArticles: 0, totalArticles: 0 },
    topPublications: [],
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
