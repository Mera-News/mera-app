// reading-stats-source — the WatermelonDB adapter for the Mera Stats card.
//
// Deliberately logic-free, mirroring the split the repo already uses for
// fact-stats (pure core beside a service that only reads rows): every decision
// about windows, dedup, coverage and labelling lives in `reading-stats.ts`, and
// everything here is a read plus a field rename. If a rule starts to appear in
// this file it is in the wrong file.
//
// It ADDS NOTHING. All four tables it reads already exist to operate the
// product: `publication_visits` runs the Sources tab, `story_impressions` runs
// feed dedup and the read-story filter, `saved_article_suggestions` runs the
// Saved tab and `tracked_stories` runs the Stories tab. No schema change, no
// migration, no new column, no new counter. Hard invariant 9 forbids the
// alternative, and the test for a new counter is "does the product stop working
// without it", not "is it anonymous".
//
// ## Why the last two go through the same readers the tabs use
//
// `loadSavedItems` and `observeActive` are the exact calls the Saved and
// Stories sub-tabs render from, not cheaper hand-rolled counts. That is the
// point: a count that disagrees with the list the reader can open and tally
// themselves is worse than no count. It also means the saved figure inherits
// `loadSavedItems`'s retention filter for free — rows with `origin`
// 'fact_check' or 'tracked_story' are kept to make an article openable, not
// saved by anyone, and counting them would both overstate saves and
// double-count a followed story's members against the followed figure.
//
// ## Why there is no "articles analysed by AI" figure here
//
// Because no device-local record of it exists, and one may not be created.
// `article_suggestions.relevance_generation_completed` is a genuine per-article
// record that the scoring pass ran, but that table is swept at 48h
// (`SUGGESTION_TTL_MS`), so a 30-day tally is unrecoverable and even a 48-hour
// one would silently undercount by every row already swept. `inference_jobs`
// has no scoring job type at all and is pruned at one hour. `story_impressions`
// has the right window and no scoring column, and conflating "reached the feed"
// with "was analysed" would overcount anyway, because
// `propagateToUnscoredSiblings` exists precisely so a sibling can inherit a
// score without being scored. The server's `articlesUsedToday` counts article
// IDs DELIVERED per UTC day, which is a different set and a different claim,
// and reading it would also make the card's own "Nothing left it" line false.
// The app keeps no running tally of its own work because nothing in the product
// needs one to function. Do not add one.

import { getAllVisitedArticles } from '@/lib/database/services/publication-visit-service';
import { loadSavedItems } from '@/lib/database/services/saved-article-suggestion-service';
import { getAll as getAllImpressions } from '@/lib/database/services/story-impression-service';
import { observeActive as observeActiveTrackedStories } from '@/lib/database/services/tracked-story-service';
import logger from '@/lib/logger';
import { firstValueFrom } from 'rxjs';
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
    const [visits, impressionRows, savedItems, trackedStories] = await Promise.all([
      getAllVisitedArticles(),
      getAllImpressions(),
      loadSavedItems(),
      // `observeActive` is a live query, and a WatermelonDB observable emits its
      // current rows on subscribe rather than waiting for a change, so the first
      // value is the answer and `firstValueFrom` unsubscribes as soon as it has
      // it. Each of the four failing independently is why they share one catch:
      // any of them throwing gives an empty card, never a half-true one.
      firstValueFrom(observeActiveTrackedStories()),
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
      keptNow: {
        savedArticles: savedItems.length,
        followedStories: trackedStories.length,
      },
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
