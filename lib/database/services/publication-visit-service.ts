// Publication-Visit Service — local-only log of every "Read Article" tap.
// Drives the Sources-tab most-visited card, the drill-down list, and the
// per-publication visit-count badge on detail screens. Composite identity
// key is (publication_name, country_code) — country_code disambiguates the
// same publisher name across markets.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import type PublicationVisitModel from '../models/PublicationVisit';

const publicationVisitsCol = database.get<PublicationVisitModel>('publication_visits');

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface RecordPublicationVisitInput {
  publicationName: string | null | undefined;
  countryCode: string | null | undefined;
  articleId?: string | null;
  articleSuggestionId?: string | null;
  articleUrl?: string | null;
  // Snapshot fields — captured so the article-history screen can render
  // a CompactPublisherNewsCard after the source article_suggestion has
  // been pruned by its 24h TTL.
  titleEn?: string | null;
  titleOriginal?: string | null;
  languageCode?: string | null;
  imageUrl?: string | null;
  pubDate?: Date | number | string | null;
}

const toDate = (value: Date | number | string | null | undefined): Date | null => {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function recordPublicationVisit(
  input: RecordPublicationVisitInput,
): Promise<void> {
  const name = (input.publicationName ?? '').trim();
  if (!name) return;

  const country = input.countryCode ?? null;
  const articleId = input.articleId ?? null;
  const articleUrl = input.articleUrl ?? null;
  const now = new Date();
  const pubDate = toDate(input.pubDate);

  try {
    // Identity = article_id. Repeated taps on the same article update
    // visited_at in-place instead of inserting a duplicate row. Rows
    // without an article_id (rare; shouldn't happen for either current
    // call site) are always inserted fresh.
    let existing: PublicationVisitModel | null = null;
    if (articleId) {
      const matches = await publicationVisitsCol
        .query(
          Q.where('publication_name', name),
          Q.where('country_code', country),
          Q.where('article_id', articleId),
        )
        .fetch();
      existing = matches[0] ?? null;
    }

    await database.write(async () => {
      if (existing) {
        await existing.update((r) => {
          r.visitedAt = now;
          // Refresh any snapshot fields the new visit can provide —
          // earlier v22 rows may have had some fields null.
          if (articleUrl) r.articleUrl = articleUrl;
          if (input.articleSuggestionId) r.articleSuggestionId = input.articleSuggestionId;
          if (input.titleEn) r.titleEn = input.titleEn;
          if (input.titleOriginal) r.titleOriginal = input.titleOriginal;
          if (input.languageCode) r.languageCode = input.languageCode;
          if (input.imageUrl) r.imageUrl = input.imageUrl;
          if (pubDate) r.pubDate = pubDate;
        });
        return;
      }
      await publicationVisitsCol.create((r) => {
        r.publicationName = name;
        r.countryCode = country;
        r.articleId = articleId;
        r.articleSuggestionId = input.articleSuggestionId ?? null;
        r.articleUrl = articleUrl;
        r.titleEn = input.titleEn ?? null;
        r.titleOriginal = input.titleOriginal ?? null;
        r.languageCode = input.languageCode ?? null;
        r.imageUrl = input.imageUrl ?? null;
        r.pubDate = pubDate;
        r.visitedAt = now;
      });
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publication-visit', method: 'record' },
    });
  }
}

export async function getVisitCountForPublication(
  publicationName: string,
  countryCode: string | null,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<number> {
  const name = publicationName.trim();
  if (!name) return 0;

  const cutoff = Date.now() - windowMs;
  try {
    const conditions = [
      Q.where('publication_name', name),
      Q.where('country_code', countryCode ?? null),
      Q.where('visited_at', Q.gte(cutoff)),
    ];
    return await publicationVisitsCol.query(...conditions).fetchCount();
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publication-visit', method: 'getCount' },
    });
    return 0;
  }
}

export interface VisitedArticle {
  articleId: string | null;
  articleSuggestionId: string | null;
  articleUrl: string | null;
  publicationName: string;
  countryCode: string | null;
  titleEn: string | null;
  titleOriginal: string | null;
  languageCode: string | null;
  imageUrl: string | null;
  pubDate: number | null;
  visitedAt: number;
  visitCount: number;
}

/**
 * Returns each article the user has visited from a given publication,
 * deduped by (articleId || articleUrl) — repeated visits collapse into a
 * single row whose `visitedAt` is the most recent tap and `visitCount` is
 * the number of taps in-window.
 *
 * Falls back to a per-row entry when neither articleId nor articleUrl is
 * present (shouldn't happen post-v23, but historical rows from v22 could
 * lack snapshot data).
 */
export async function getVisitsForPublication(
  publicationName: string,
  countryCode: string | null,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<VisitedArticle[]> {
  const name = publicationName.trim();
  if (!name) return [];

  const cutoff = Date.now() - windowMs;
  try {
    const rows = await publicationVisitsCol
      .query(
        Q.where('publication_name', name),
        Q.where('country_code', countryCode ?? null),
        Q.where('visited_at', Q.gte(cutoff)),
      )
      .fetch();

    const grouped = new Map<string, VisitedArticle>();
    for (const row of rows) {
      const dedupeKey = row.articleId ?? row.articleUrl ?? `__row_${row.id}`;
      const visitedAt = row.visitedAt instanceof Date
        ? row.visitedAt.getTime()
        : Number(row.visitedAt);
      const pubDate = row.pubDate instanceof Date
        ? row.pubDate.getTime()
        : row.pubDate != null
          ? Number(row.pubDate)
          : null;
      const existing = grouped.get(dedupeKey);
      if (existing) {
        existing.visitCount += 1;
        if (visitedAt > existing.visitedAt) {
          existing.visitedAt = visitedAt;
          // Prefer the freshest non-null snapshot fields — earlier visits
          // may pre-date the v23 columns being populated.
          existing.titleEn = row.titleEn ?? existing.titleEn;
          existing.titleOriginal = row.titleOriginal ?? existing.titleOriginal;
          existing.imageUrl = row.imageUrl ?? existing.imageUrl;
          existing.languageCode = row.languageCode ?? existing.languageCode;
          existing.pubDate = pubDate ?? existing.pubDate;
        }
      } else {
        grouped.set(dedupeKey, {
          articleId: row.articleId,
          articleSuggestionId: row.articleSuggestionId,
          articleUrl: row.articleUrl,
          publicationName: row.publicationName,
          countryCode: row.countryCode,
          titleEn: row.titleEn,
          titleOriginal: row.titleOriginal,
          languageCode: row.languageCode,
          imageUrl: row.imageUrl,
          pubDate,
          visitedAt,
          visitCount: 1,
        });
      }
    }

    return [...grouped.values()].sort((a, b) => b.visitedAt - a.visitedAt);
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publication-visit', method: 'getVisitsForPublication' },
    });
    return [];
  }
}

export interface VisitedPublication {
  publicationName: string;
  countryCode: string | null;
  visitCount: number;
  lastVisitedAt: number;
}

/**
 * Deletes visit rows older than `windowMs` (default 30 days). Called once
 * per app boot from `hydrateAllStores` so the table can't grow unbounded —
 * rows past the rolling window are never surfaced anyway. Cheap: an indexed
 * range scan + permanent destroy.
 */
export async function pruneStaleVisits(
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<void> {
  try {
    const cutoff = Date.now() - windowMs;
    const stale = await publicationVisitsCol
      .query(Q.where('visited_at', Q.lt(cutoff)))
      .fetch();
    if (stale.length === 0) return;
    await database.write(async () => {
      await database.batch(...stale.map((r) => r.prepareDestroyPermanently()));
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publication-visit', method: 'prune' },
    });
  }
}

/**
 * Wipes every row in `publication_visits`. Wired into the "Clear viewing
 * history" button on the Manage Data screen.
 */
export async function clearAllVisits(): Promise<void> {
  try {
    const rows = await publicationVisitsCol.query().fetch();
    if (rows.length === 0) return;
    await database.write(async () => {
      await database.batch(...rows.map((r) => r.prepareDestroyPermanently()));
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publication-visit', method: 'clearAll' },
    });
    throw error;
  }
}

export async function getTopVisitedPublications(opts?: {
  limit?: number;
  windowMs?: number;
}): Promise<VisitedPublication[]> {
  const limit = opts?.limit ?? Infinity;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const cutoff = Date.now() - windowMs;

  try {
    const rows = await publicationVisitsCol
      .query(Q.where('visited_at', Q.gte(cutoff)))
      .fetch();

    const grouped = new Map<string, VisitedPublication>();
    for (const row of rows) {
      const country = row.countryCode ?? null;
      const key = `${row.publicationName} ${country ?? ''}`;
      const visitedAt = row.visitedAt instanceof Date
        ? row.visitedAt.getTime()
        : Number(row.visitedAt);
      const existing = grouped.get(key);
      if (existing) {
        existing.visitCount += 1;
        if (visitedAt > existing.lastVisitedAt) {
          existing.lastVisitedAt = visitedAt;
        }
      } else {
        grouped.set(key, {
          publicationName: row.publicationName,
          countryCode: country,
          visitCount: 1,
          lastVisitedAt: visitedAt,
        });
      }
    }

    const sorted = [...grouped.values()].sort((a, b) => {
      if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
      return b.lastVisitedAt - a.lastVisitedAt;
    });

    return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'publication-visit', method: 'getTop' },
    });
    return [];
  }
}
