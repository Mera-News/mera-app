// Settings rows owned by the background refresh (the `mera-background` OS task).
//
// Every read here goes straight to the WatermelonDB `settings` table rather
// than through a store: the OS can start this process purely to run the task,
// and nothing hydrates a store in that wake. None of these keys is in the
// backup allowlist, so none of them travels to another device; logout resets
// them with the rest of the table.

import { getSetting, setSetting } from '@/lib/database/services/setting-service';

/** The user's toggle. Absent means ON: the feature ships enabled. */
export const BG_REFRESH_ENABLED_KEY = 'bg_inference_submit_enabled';

/** Epoch ms of the last REAL foreground (AppState 'active'), written by the
 *  scheduler. A background wake cannot learn this any other way: the only
 *  other copy lives inside the restart marker, which is deleted on read. */
export const LAST_FOREGROUND_AT_KEY = 'last_foreground_at';

/** The last `dailyArticleLimit` entitlement-sync saw. Background may spend at
 *  most half of it per UTC day. */
export const LAST_DAILY_ARTICLE_LIMIT_KEY = 'last_daily_article_limit';

/** UTC day key (`YYYY-MM-DD`) on which a background hydrate hit the server's
 *  daily cap. Background skips its fetch for the rest of that day. */
export const BG_QUOTA_EXHAUSTED_DAY_KEY = 'bg_quota_exhausted_day';

/** Prefix of the per-UTC-day ledger of metered articles background runs were
 *  granted: `bg_articles_charged:2026-09-28` -> "37". */
export const BG_ARTICLES_CHARGED_PREFIX = 'bg_articles_charged:';

export async function isBgRefreshEnabled(): Promise<boolean> {
  return (await getSetting(BG_REFRESH_ENABLED_KEY)) !== '0';
}

/**
 * Persist the toggle, then bring the OS registration in line with it. OFF must
 * UNREGISTER the task (a device that said no has no wake at all), and ON must
 * register it again; the reconciler owns both, so they cannot drift.
 */
export async function setBgRefreshEnabled(enabled: boolean): Promise<void> {
  await setSetting(BG_REFRESH_ENABLED_KEY, enabled ? '1' : '0');
  try {
    // Lazy: the task module pulls expo-background-task in, and this file is
    // read by the settings screen and the scheduler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { syncBackgroundTaskRegistration } = require('./background-task') as typeof import('./background-task');
    await syncBackgroundTaskRegistration();
  } catch {
    // The run itself re-reads the toggle, so a failed registration change can
    // cost at most one wake that exits at its first read.
  }
}

export async function recordForeground(at: number): Promise<void> {
  await setSetting(LAST_FOREGROUND_AT_KEY, String(at));
}

export async function readLastForegroundAt(): Promise<number | null> {
  return parseFiniteNumber(await getSetting(LAST_FOREGROUND_AT_KEY));
}

/** Called by entitlement-sync with the server's answer. Never throws. */
export async function rememberDailyArticleLimit(limit: unknown): Promise<void> {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return;
  try {
    await setSetting(LAST_DAILY_ARTICLE_LIMIT_KEY, String(Math.floor(limit)));
  } catch {
    // The allowance falls back to the Starter limit without it.
  }
}

export function parseFiniteNumber(value: string | null): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
