// The open-ready target: how much a background run should fetch, if anything.
//
// The owner's rule: when the reader opens the app there should be AT LEAST
// OPEN_READY_TARGET relevant articles (passing the render gate) published in the
// last FRESH_WINDOW_MS. Background does no more than that, so a light reader's
// content is never fetched and scored for nothing.
//
// Three local numbers, one table scan, no network:
//   relevant6h  rows the reader can already see (complete or reason_pending,
//               published inside the window, passing the per-row gate). The
//               status filter also drops excluded and already-read rows, which
//               have terminal statuses of their own.
//   pending6h   window rows still unscored (queued or in flight). Counting them
//               at the measured yield stops over-fetching while results are
//               pending, and unlike a "some batch is waiting" rule one wedged
//               batch cannot block the fetch forever.
//   yield       THIS device's own gate-pass ratio over the table (48h window by
//               the table's own TTL). Default YIELD_DEFAULT until enough rows
//               have been scored to trust the ratio.

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { relevancePassesGate } from '@/lib/stores/fact-rows-selector';

export const OPEN_READY_TARGET = 50;
export const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
export const YIELD_DEFAULT = 0.33;
export const YIELD_MIN_SAMPLE = 20;
/** Floor on the yield used for sizing, so a device whose last rows all missed
 *  the gate cannot ask for an unbounded fetch. The per-run cap binds anyway. */
export const YIELD_FLOOR = 0.05;

export interface OpenReadiness {
  relevant6h: number;
  pending6h: number;
  yield: number;
  /** How many scored rows the yield was measured over. */
  yieldSample: number;
}

/**
 * Insert time of a Mongo ObjectId, in epoch ms, or null for anything that is
 * not a 24-hex ObjectId. The first 4 bytes are seconds since the epoch, written
 * by the server when the article row was inserted.
 *
 * Why this is a safe PRE-hydrate filter: an article is inserted after it is
 * published, so "published inside the window" implies "inserted inside the
 * window". Filtering on insert time can let a few older articles through (a
 * feed that published late), but it never drops a fresh one. The ids call
 * carries no dates, and `PersonaQueryInput` has no date argument, so this is the
 * only way to avoid CHARGING for an old article before knowing its date.
 */
export function objectIdTimestampMs(id: string): number | null {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  return parseInt(id.slice(0, 8), 16) * 1000;
}

export function isInsertedWithinWindow(id: string, now: number): boolean {
  const ts = objectIdTimestampMs(id);
  return ts !== null && ts >= now - FRESH_WINDOW_MS;
}

interface RawSuggestion {
  status?: unknown;
  relevance?: unknown;
  first_pub_date?: unknown;
  scored_with_v3?: unknown;
}

/** Pure half of {@link measureOpenReadiness}, over raw rows. */
export function computeOpenReadiness(rows: readonly RawSuggestion[], now: number): OpenReadiness {
  const windowStart = now - FRESH_WINDOW_MS;
  let relevant6h = 0;
  let pending6h = 0;
  let scored = 0;
  let passing = 0;
  for (const raw of rows) {
    const status = raw.status;
    const pubMs = typeof raw.first_pub_date === 'number' ? raw.first_pub_date : 0;
    const fresh = pubMs >= windowStart;
    if (status === ArticleSuggestionStatus.Unscored) {
      if (fresh) pending6h += 1;
      continue;
    }
    if (status !== ArticleSuggestionStatus.Complete && status !== ArticleSuggestionStatus.ReasonPending) {
      continue;
    }
    const passes = relevancePassesGate({
      relevance: typeof raw.relevance === 'number' ? raw.relevance : 0,
      // SQLite hands booleans back as 1/0 through the raw path.
      scoredWithV3: raw.scored_with_v3 === true || raw.scored_with_v3 === 1,
    });
    scored += 1;
    if (passes) {
      passing += 1;
      if (fresh) relevant6h += 1;
    }
  }
  const measured = scored >= YIELD_MIN_SAMPLE ? passing / scored : YIELD_DEFAULT;
  return { relevant6h, pending6h, yield: Math.max(YIELD_FLOOR, measured), yieldSample: scored };
}

export async function measureOpenReadiness(now: number): Promise<OpenReadiness> {
  // Lazy, both: the database singleton opens SQLite at import, and the
  // watermelondb index reaches native modules at import too. This module is
  // pure otherwise and is read by code that must load without a device.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const database = (require('@/lib/database/index') as typeof import('@/lib/database/index')).default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Q } = require('@nozbe/watermelondb') as typeof import('@nozbe/watermelondb');
  const rows = (await database
    .get('article_suggestions')
    .query(
      Q.where(
        'status',
        Q.oneOf([
          ArticleSuggestionStatus.Unscored,
          ArticleSuggestionStatus.ReasonPending,
          ArticleSuggestionStatus.Complete,
        ]),
      ),
    )
    .unsafeFetchRaw()) as RawSuggestion[];
  return computeOpenReadiness(rows, now);
}

/**
 * Metered articles to hydrate this run: zero once the expected count reaches
 * the target, otherwise enough to close the gap at the measured yield, never
 * more than the allowance lets this run spend.
 */
export function plannedMeteredFetch(readiness: OpenReadiness, allowance: number): number {
  const expected = readiness.relevant6h + readiness.yield * readiness.pending6h;
  if (expected >= OPEN_READY_TARGET) return 0;
  const needed = Math.ceil((OPEN_READY_TARGET - expected) / readiness.yield);
  return Math.max(0, Math.min(needed, allowance));
}
