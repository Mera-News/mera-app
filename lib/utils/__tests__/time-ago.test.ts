// time-ago — pure util tests. RN-free.
//
// Covers the ladder boundaries (just-now / minutes / hours / days), the
// `toEpochMs` normalization + null cases, `emptyLabel`, `absoluteAfterDays`,
// and the injected `now` clock.

import { formatTimeAgo, toEpochMs } from '../time-ago';
import type { TFunction } from 'i18next';

const NOW = 1_000_000_000_000; // fixed clock
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const t = ((key: string, opts?: { count?: number }) =>
  opts?.count != null ? `${key}:${opts.count}` : key) as unknown as TFunction;

describe('toEpochMs', () => {
  it('returns null for null/undefined', () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
  });

  it('returns null for an unparsable string', () => {
    expect(toEpochMs('not-a-date')).toBeNull();
    expect(toEpochMs('')).toBeNull();
  });

  it('returns null for a non-finite or <= 0 number', () => {
    expect(toEpochMs(0)).toBeNull();
    expect(toEpochMs(-5)).toBeNull();
    expect(toEpochMs(Number.NaN)).toBeNull();
  });

  it('accepts a Date, a positive number, and an ISO string', () => {
    expect(toEpochMs(new Date(NOW))).toBe(NOW);
    expect(toEpochMs(NOW)).toBe(NOW);
    expect(toEpochMs(new Date(NOW).toISOString())).toBe(NOW);
  });
});

describe('formatTimeAgo — ladder boundaries', () => {
  it('< 1 minute → justNow', () => {
    expect(formatTimeAgo(t, NOW, { now: NOW })).toBe('feed.justNow');
    expect(formatTimeAgo(t, NOW - (MIN - 1), { now: NOW })).toBe('feed.justNow');
  });

  it('exactly 1 minute → minutesAgo:1; < 60 minutes → minutesAgo', () => {
    expect(formatTimeAgo(t, NOW - MIN, { now: NOW })).toBe('feed.minutesAgo:1');
    expect(formatTimeAgo(t, NOW - 45 * MIN, { now: NOW })).toBe('feed.minutesAgo:45');
    expect(formatTimeAgo(t, NOW - (HOUR - 1), { now: NOW })).toBe('feed.minutesAgo:59');
  });

  it('exactly 1 hour → hoursAgo:1; < 24 hours → hoursAgo', () => {
    expect(formatTimeAgo(t, NOW - HOUR, { now: NOW })).toBe('feed.hoursAgo:1');
    expect(formatTimeAgo(t, NOW - 10 * HOUR, { now: NOW })).toBe('feed.hoursAgo:10');
    expect(formatTimeAgo(t, NOW - (DAY - 1), { now: NOW })).toBe('feed.hoursAgo:23');
  });

  it('exactly 1 day and beyond → daysAgo (unbounded by default)', () => {
    expect(formatTimeAgo(t, NOW - DAY, { now: NOW })).toBe('feed.daysAgo:1');
    expect(formatTimeAgo(t, NOW - 30 * DAY, { now: NOW })).toBe('feed.daysAgo:30');
    expect(formatTimeAgo(t, NOW - 365 * DAY, { now: NOW })).toBe('feed.daysAgo:365');
  });

  it('clamps a future/clock-skewed timestamp to justNow (diff clamped >= 0)', () => {
    expect(formatTimeAgo(t, NOW + HOUR, { now: NOW })).toBe('feed.justNow');
  });
});

describe('formatTimeAgo — emptyLabel', () => {
  it('defaults to "" for missing/unparsable input', () => {
    expect(formatTimeAgo(t, null)).toBe('');
    expect(formatTimeAgo(t, undefined)).toBe('');
    expect(formatTimeAgo(t, 'garbage')).toBe('');
    expect(formatTimeAgo(t, 0)).toBe('');
  });

  it('returns the custom emptyLabel when supplied', () => {
    expect(formatTimeAgo(t, null, { emptyLabel: 'Never' })).toBe('Never');
    expect(formatTimeAgo(t, 'garbage', { emptyLabel: 'feed.justNow' })).toBe('feed.justNow');
  });
});

describe('formatTimeAgo — absoluteAfterDays', () => {
  it('switches to an absolute locale date once the threshold is reached', () => {
    const ts = NOW - 7 * DAY;
    const expected = new Date(ts).toLocaleDateString();
    expect(formatTimeAgo(t, ts, { now: NOW, absoluteAfterDays: 7 })).toBe(expected);
  });

  it('stays on the daysAgo ladder just below the threshold', () => {
    const ts = NOW - (7 * DAY - 1);
    expect(formatTimeAgo(t, ts, { now: NOW, absoluteAfterDays: 7 })).toBe('feed.daysAgo:6');
  });

  it('is unbounded (no absolute fallback) when omitted', () => {
    const ts = NOW - 400 * DAY;
    expect(formatTimeAgo(t, ts, { now: NOW })).toBe('feed.daysAgo:400');
  });
});

describe('formatTimeAgo — injected now', () => {
  it('uses the injected clock instead of Date.now()', () => {
    const ts = NOW - 3 * HOUR;
    expect(formatTimeAgo(t, ts, { now: NOW })).toBe('feed.hoursAgo:3');
    // A later injected clock ages the same timestamp further.
    expect(formatTimeAgo(t, ts, { now: NOW + 21 * HOUR })).toBe('feed.daysAgo:1');
  });
});
