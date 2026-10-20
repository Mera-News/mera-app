// What the reading meter shows, as one pure decision (no React, no RN).
// Inputs come from the read hold, the reading query and the processing mode;
// ReadingMeter.tsx only draws the result.

import { nextUtcMidnight, resetDayWord } from '@/lib/subscription/read-hold';

export interface ReadingMeterInput {
  /** Share of today's reading used, 0..1; null when unknown. */
  used: number | null;
  held: boolean;
  holdResetAt: number | null;
  now: number;
  online: boolean;
  /** Device time of the last write to the hold. */
  updatedAt: number | null;
  onDevice: boolean;
  planRaised: boolean;
}

export interface ReadingMeterModel {
  /** On device the card shows only the mode and "Unlimited": no bar, reset, offline or held line. */
  mode: 'cloud' | 'onDevice';
  percent: number | null;
  done: boolean;
  resetAt: number;
  resetDay: 'today' | 'tomorrow';
  lastUpdatedAt: number | null;
  showNewPlan: boolean;
  showOfflineOnly: boolean;
}

export function readingMeterModel(i: ReadingMeterInput): ReadingMeterModel {
  const resetAt = i.held && i.holdResetAt != null ? i.holdResetAt : nextUtcMidnight(i.now);
  const resetDay = resetDayWord(resetAt, i.now);
  // On device is never held and never metered, so it wins over every cloud state.
  if (i.onDevice) {
    return { mode: 'onDevice', percent: null, done: false, resetAt, resetDay, lastUpdatedAt: null, showNewPlan: false, showOfflineOnly: false };
  }
  const done = i.held || (i.used != null && i.used >= 1);
  const percent = done
    ? 100
    : i.used != null
      ? Math.max(0, Math.min(100, Math.round(i.used * 100)))
      : i.online
        ? 0
        : null;
  return {
    mode: 'cloud',
    percent,
    done,
    resetAt,
    resetDay,
    lastUpdatedAt: i.online ? null : i.updatedAt,
    showNewPlan: i.planRaised,
    showOfflineOnly: !i.online && percent == null,
  };
}
