// reading-stats-source — the WatermelonDB adapter for the Mera Stats card.
//
// Deliberately logic-free, mirroring the split the repo already uses for
// fact-stats (pure core beside a service that only reads rows): every decision
// about windows, dedup, coverage and labelling lives in `reading-stats.ts`, and
// everything here is a read plus a field rename. If a rule starts to appear in
// this file it is in the wrong file.
//
// It ADDS NOTHING. Both tables it reads already exist to operate the product:
// `publication_visits` runs the Sources tab, `story_impressions` runs feed dedup
// and the read-story filter. No schema change, no migration, no new column, no
// new counter. Hard invariant 9 forbids the alternative.

import { getAllVisitedArticles } from '@/lib/database/services/publication-visit-service';
import { getAll as getAllImpressions } from '@/lib/database/services/story-impression-service';
import logger from '@/lib/logger';
import {
  computeReadingStats,
  emptyReadingStats,
  type ReadingStats,
  type StatsImpression,
} from './reading-stats';

/** `@date` columns surface as `Date`, but a partially-written row can be null
 *  and the test mock hands back raw numbers. Same normaliser the impression
 *  service uses internally, repeated rather than exported across the boundary:
 *  three lines beat reaching into another service's private helper. */
function toMs(value: Date | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? ms : null;
}

export interface LoadReadingStatsOptions {
  /** Injectable for tests and for keeping one card render consistent with
   *  itself; defaults to the clock at call time. */
  nowMs?: number;
  topPublicationLimit?: number;
}

/**
 * Reads both tables and hands them to the pure core.
 *
 * Returns the empty shape rather than throwing when a read fails: this powers a
 * share card, and a crashed preview screen is a worse outcome than a card that
 * says there is nothing to show yet. Both underlying services already swallow
 * and report their own errors, so this catch is the belt to their braces.
 */
export async function loadReadingStats(
  options: LoadReadingStatsOptions = {},
): Promise<ReadingStats> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const [visits, impressionRows] = await Promise.all([
      getAllVisitedArticles(),
      getAllImpressions(),
    ]);

    const impressions: StatsImpression[] = impressionRows.map((row) => ({
      articleId: row.articleId,
      opened: row.opened === true,
      firstSeenAtMs: toMs(row.firstSeenAt),
    }));

    return computeReadingStats({
      visits,
      impressions,
      nowMs,
      ...(options.topPublicationLimit !== undefined
        ? { topPublicationLimit: options.topPublicationLimit }
        : {}),
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'reading-stats', method: 'loadReadingStats' },
    });
    return emptyReadingStats();
  }
}
