// The Feed's age label for a story kept past 24h (D7): nothing under a day, then
// "From yesterday", the weekday for 2-5 local days back, a short date from 6.
// Local CALENDAR days, not hours: a story 40h old at 9am is from two days ago.

import { toEpochMs, type TimeAgoInput } from '@/lib/algorithms/time-ago';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function feedAgeLabel(pubDate: TimeAgoInput, now: number, locale: string | undefined, t: TFunction): string | null {
  const ms = toEpochMs(pubDate);
  if (ms === null || now - ms < DAY_MS) return null;
  // Rounded, so a DST day of 23 or 25 hours still counts as one day.
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 1) return t('feed.age.yesterday');
  const at = new Date(ms);
  if (days <= 5) return t('feed.age.fromDay', { day: at.toLocaleDateString(locale, { weekday: 'long' }) });
  return t('feed.age.fromDate', { date: at.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) });
}

/** Decided once at mount, never re-derived: the large card draws the label as
 *  its own line, so one crossing 24h mid-session would push every row below
 *  it (invariant 5). */
export function useFrozenFeedAgeLabel(pubDate: TimeAgoInput): string | null {
  const { t, i18n } = useTranslation();
  const [label] = useState(() => feedAgeLabel(pubDate, Date.now(), i18n?.language, t));
  return label;
}
