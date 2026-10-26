// activity — the pure regroupings behind the Library Activity page's detail
// screens (Where you read, Languages, What you opened, How fresh) and their
// text shares. RN-free and DB-free (type imports only).
//
// Like the rest of `lib/stats/`, this adds no table, column or counter: every
// figure is a regrouping of the windowed `publication_visits` rows the Stats
// already read (`getAllVisitedArticles`, one row per article).

import { normPublicationName } from '@/lib/algorithms/geo-language-priority';
import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';

import { localDateKey } from './reading-stats';

/** One country on Where you read. */
export interface CountryRow {
  countryCode: string;
  /** Distinct publications (normalised name, the History merge's rule), so it
   *  equals the rows History shows for this country. */
  publications: number;
  /** Distinct articles opened. */
  articles: number;
}

/** Every country with an article, most articles first, then by code. */
export function countryRows(visits: readonly VisitedArticle[]): CountryRow[] {
  const by = new Map<string, { names: Set<string>; articles: number }>();
  for (const v of visits) {
    const code = (v.countryCode ?? '').trim();
    if (!code) continue;
    const row = by.get(code) ?? { names: new Set<string>(), articles: 0 };
    row.articles += 1;
    const name = normPublicationName(v.publicationName);
    if (name) row.names.add(name);
    by.set(code, row);
  }
  return [...by.entries()]
    .map(([countryCode, r]) => ({ countryCode, publications: r.names.size, articles: r.articles }))
    .sort((a, b) => b.articles - a.articles || a.countryCode.localeCompare(b.countryCode));
}

/** One language on the Languages screen: its articles and their share. */
export interface LanguageRow {
  languageCode: string;
  articles: number;
  /** 0..1 of the articles that carry a language. */
  share: number;
}

/** Every language, most articles first. Rows without a language count nowhere
 *  (the Languages card's rule). */
export function languageRows(visits: readonly VisitedArticle[]): LanguageRow[] {
  const by = new Map<string, number>();
  for (const v of visits) {
    const code = (v.languageCode ?? '').trim();
    if (code) by.set(code, (by.get(code) ?? 0) + 1);
  }
  const total = [...by.values()].reduce((s, n) => s + n, 0);
  return [...by.entries()]
    .map(([languageCode, articles]) => ({ languageCode, articles, share: total > 0 ? articles / total : 0 }))
    .sort((a, b) => b.articles - a.articles || a.languageCode.localeCompare(b.languageCode));
}

/** The reading log's filters. `day` is a local `YYYY-MM-DD` (`DayRead.dateKey`). */
export interface LogFilter {
  readonly day?: string | null;
  readonly language?: string | null;
}

/** The visits a filter keeps, input order kept (the service returns newest first). */
export function filterVisits(visits: readonly VisitedArticle[], filter: LogFilter): VisitedArticle[] {
  return visits.filter(
    (v) =>
      (!filter.language || (v.languageCode ?? '').trim() === filter.language) &&
      (!filter.day || localDateKey(v.visitedAt) === filter.day),
  );
}

/** How fresh's bands, by upper bound in hours. The last is open-ended. */
export const FRESH_BANDS = ['hour', 'sixHours', 'day', 'threeDays', 'older'] as const;
export type FreshBand = (typeof FRESH_BANDS)[number];
const BAND_UPPER_HOURS: readonly number[] = [1, 6, 24, 72, Infinity];

export interface Freshness {
  /** Articles per band, in `FRESH_BANDS` order. */
  counts: number[];
  /** Articles with a publish time (the bands' total). */
  sampled: number;
  /** Every article. `total - sampled` had no publish time. */
  total: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Publish-to-read age per article, banded: the same rows and the same
 * `visitedAt - pubDate` the How fresh card's median uses
 * (`computePublishToReadStats`). A publish time after the visit (a clock or
 * feed error) lands in the first band, as it sorts first for the median.
 */
export function freshnessBands(visits: readonly VisitedArticle[]): Freshness {
  const counts = FRESH_BANDS.map(() => 0);
  let sampled = 0;
  for (const v of visits) {
    if (v.pubDate == null) continue;
    const hours = (v.visitedAt - v.pubDate) / MS_PER_HOUR;
    counts[BAND_UPPER_HOURS.findIndex((upper) => hours < upper)] += 1;
    sampled += 1;
  }
  return { counts, sampled, total: visits.length };
}

/**
 * A text share: a heading, one line per item, then the "Shared via" footer
 * and the privacy line, blocks split by a blank line (useShareArticle's shape).
 */
export function buildActivityShareText(heading: string, lines: readonly string[], footer: string, privacy: string): string {
  return [heading, lines.join('\n'), footer, privacy].filter(Boolean).join('\n\n');
}
