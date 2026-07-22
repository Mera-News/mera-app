// time-ago — the shared "Xm ago" / "Xh ago" / "Xd ago" formatter behind every
// relative-timestamp label in the app (feed cards, tracked stories, visited
// publications, observability, the Dashboard "last processed" line, persona
// audit). Consolidates six near-identical copies of the same ladder into one
// pure, RN-free util.
//
// PURE: no DB / expo / react-native imports — takes the i18next `t` function
// as a parameter so it unit-tests without a device or a live i18n instance.

import type { TFunction } from 'i18next';

/** Accepted timestamp shapes across the app's call sites. */
export type TimeAgoInput = string | number | Date | null | undefined;

/**
 * Normalize any `TimeAgoInput` to epoch milliseconds.
 *
 * @returns `null` when `input` is missing (`null`/`undefined`), unparsable
 *          (`NaN` from `Date.parse` / a non-finite number), or `<= 0` — a
 *          zero or negative epoch is never a meaningful "ago" timestamp.
 */
export function toEpochMs(input: TimeAgoInput): number | null {
  if (input == null) return null;
  const ms = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

export interface FormatTimeAgoOptions {
  /** Injected clock (epoch ms) — defaults to `Date.now()`. Deterministic
   *  testing / ticking-clock callers pass this explicitly. */
  now?: number;
  /** Returned verbatim when `input` is missing/unparsable. Default `''`. */
  emptyLabel?: string;
  /** When set, once the age reaches this many whole days the function
   *  switches to an absolute `Date#toLocaleDateString()` label instead of
   *  continuing the "Nd ago" ladder. Omit for unlimited days-ago. */
  absoluteAfterDays?: number;
}

/**
 * The shared relative-time ladder: <1m → `feed.justNow`, <60m →
 * `feed.minutesAgo`, <24h → `feed.hoursAgo`, else `feed.daysAgo` (or, once
 * `absoluteAfterDays` is reached, an absolute locale date string). The
 * now-vs-input diff is clamped to `>= 0` so a future/clock-skewed timestamp
 * never produces a negative count — it just reads "just now".
 */
export function formatTimeAgo(t: TFunction, input: TimeAgoInput, opts: FormatTimeAgoOptions = {}): string {
  const { now = Date.now(), emptyLabel = '', absoluteAfterDays } = opts;
  const ms = toEpochMs(input);
  if (ms == null) return emptyLabel;

  const diffMs = Math.max(0, now - ms);
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  if (mins < 1) return t('feed.justNow');
  if (mins < 60) return t('feed.minutesAgo', { count: mins });
  if (hours < 24) return t('feed.hoursAgo', { count: hours });
  if (absoluteAfterDays != null && days >= absoluteAfterDays) {
    return new Date(ms).toLocaleDateString();
  }
  return t('feed.daysAgo', { count: days });
}
