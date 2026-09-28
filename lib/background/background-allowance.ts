// How many METERED articles a background run may hydrate.
//
// The server counts the daily article allowance at hydrate, per article id,
// and resets it at 00:00 UTC (mera-server `reserveArticleQuota`). The ids call
// and the followed-story hydrate are free. Background must never eat the
// allowance a reader needs when they actually open the app, so it is bounded
// twice, both locally and with no extra round trip:
//
//   - at most BG_RUN_METERED_CAP per run;
//   - at most HALF of the user's daily limit per UTC day, summed in a ledger of
//     what the server actually GRANTED to background runs.
//
// A server `dailyLimitReached` during a background run closes background for
// the rest of that UTC day, whatever the ledger says: the foreground spent the
// rest, and the reader is the one who gets it.

import {
  deleteSetting,
  getSetting,
  getSettingsByPrefix,
  setSetting,
} from '@/lib/database/services/setting-service';

import {
  BG_ARTICLES_CHARGED_PREFIX,
  BG_QUOTA_EXHAUSTED_DAY_KEY,
  LAST_DAILY_ARTICLE_LIMIT_KEY,
  parseFiniteNumber,
} from './bg-refresh-settings';

export const BG_RUN_METERED_CAP = 50;

/** Assumed when entitlement-sync has never answered on this device: every
 *  account holds at least Starter, whose limit is 250. */
export const STARTER_FALLBACK_DAILY_LIMIT = 250;

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface BackgroundAllowance {
  /** Metered articles this run may hydrate: min(per-run cap, day budget left). */
  perRun: number;
  /** Half the daily limit. */
  dayCap: number;
  /** Already granted to background runs today. */
  chargedToday: number;
  /** The server said the cap was reached today. */
  exhausted: boolean;
}

export async function readAllowance(now: number): Promise<BackgroundAllowance> {
  const day = utcDayKey(now);
  const [limitRaw, chargedRaw, exhaustedDay] = await Promise.all([
    getSetting(LAST_DAILY_ARTICLE_LIMIT_KEY),
    getSetting(BG_ARTICLES_CHARGED_PREFIX + day),
    getSetting(BG_QUOTA_EXHAUSTED_DAY_KEY),
  ]);
  const limit = parseFiniteNumber(limitRaw) ?? STARTER_FALLBACK_DAILY_LIMIT;
  const dayCap = Math.max(0, Math.floor(limit / 2));
  const chargedToday = Math.max(0, parseFiniteNumber(chargedRaw) ?? 0);
  const exhausted = exhaustedDay === day;
  const left = exhausted ? 0 : Math.max(0, dayCap - chargedToday);
  return { perRun: Math.min(BG_RUN_METERED_CAP, left), dayCap, chargedToday, exhausted };
}

/**
 * Add what the server granted to today's ledger, and drop every other day's
 * row so the ledger never grows past one row.
 */
export async function recordCharged(now: number, granted: number): Promise<void> {
  const day = utcDayKey(now);
  const key = BG_ARTICLES_CHARGED_PREFIX + day;
  const rows = await getSettingsByPrefix(BG_ARTICLES_CHARGED_PREFIX);
  const current = Math.max(0, parseFiniteNumber(rows[key] ?? null) ?? 0);
  if (granted > 0) await setSetting(key, String(current + Math.floor(granted)));
  for (const staleKey of Object.keys(rows)) {
    if (staleKey !== key) await deleteSetting(staleKey);
  }
}

export async function markQuotaExhausted(now: number): Promise<void> {
  await setSetting(BG_QUOTA_EXHAUSTED_DAY_KEY, utcDayKey(now));
}
