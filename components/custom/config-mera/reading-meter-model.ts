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
  onDeviceSupported: boolean;
  multiplier: number;
  planRaised: boolean;
}

export interface ReadingMeterModel {
  percent: number | null;
  done: boolean;
  resetAt: number;
  resetDay: 'today' | 'tomorrow';
  lastUpdatedAt: number | null;
  dimmed: boolean;
  showOnPhoneLine: boolean;
  showUnlimitedLine: boolean;
  multiplierKey: 'base' | 'n';
  showNewPlan: boolean;
  showOfflineOnly: boolean;
}

export function readingMeterModel(i: ReadingMeterInput): ReadingMeterModel {
  const done = i.held || (i.used != null && i.used >= 1);
  const percent = done
    ? 100
    : i.used != null
      ? Math.max(0, Math.min(100, Math.round(i.used * 100)))
      : i.online
        ? 0
        : null;
  const resetAt = i.held && i.holdResetAt != null ? i.holdResetAt : nextUtcMidnight(i.now);
  return {
    percent,
    done,
    resetAt,
    resetDay: resetDayWord(resetAt, i.now),
    lastUpdatedAt: i.online ? null : i.updatedAt,
    dimmed: i.onDevice,
    showOnPhoneLine: i.onDevice,
    showUnlimitedLine: i.onDeviceSupported,
    multiplierKey: i.multiplier <= 1 ? 'base' : 'n',
    showNewPlan: i.planRaised,
    showOfflineOnly: !i.online && percent == null,
  };
}
