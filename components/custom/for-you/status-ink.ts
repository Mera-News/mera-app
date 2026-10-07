// Ink for the feed's counts card and status icon, in ONE place.
//
// Colours live in `style`, never in a NativeWind class: the dark ramp is an
// inversion (`typography-300` is darker than `-400`), and a class-name
// assertion cannot see the colour it resolves to. The card is drawn over list
// content when it slides in, so it takes the opaque `modalBase` token there.

import type { FeedStatusMode } from '@/lib/feed-status-mode';
import type { ThemeColors } from '@/lib/theme/tokens';

/** Pure text colours. `secondary` is the floor: rgb 163 only reaches 4.6:1
 *  over the worst modelled panel and rgb 140 reaches 3.5:1. */
export const STATUS_INK = {
  primary: '#FFFFFF',
  secondary: 'rgb(212, 212, 212)',
  divider: 'rgba(255, 255, 255, 0.12)',
} as const;

/** The Feed's status icon, by mode: still and plain at rest, orange at the
 *  daily limit, red on a problem (FinalFeedStatus). `deferred` rests like idle. */
export function statusIconInk(mode: FeedStatusMode, c: ThemeColors): string {
  if (mode === 'limited') return c.accent;
  if (mode === 'error') return c.negative;
  return c.ink;
}

/**
 * ONE scoring progress figure. The panel used to show the cloud sweep's
 * synced-id counter ("Cloud scoring 30 / 36") beside the batch article
 * progress ("Analysing 30 of 39 articles"): two totals for one job, side by
 * side. Both now read this, so they cannot disagree. The batch progress is
 * preferred: it counts ARTICLES in the current run, the unit the sentence
 * names.
 */
export function pickScoringProgress(
  batch: { done: number; total: number } | null | undefined,
  asyncDone: number,
  asyncTotal: number,
): { done: number; total: number } | null {
  if (batch && batch.total > 0) return { done: batch.done, total: batch.total };
  if (asyncTotal > 0) return { done: asyncDone, total: asyncTotal };
  return null;
}

/**
 * The state half of the accessibility label.
 *
 * Ink is the ONLY thing that separated these states, which made the capped
 * state (amber) and the error state (red) identical to a screen reader: the
 * label was a constant "Open feed status" in every mode. `deferred` folds onto
 * `idle` here for the same reason it shares the resting colour — it is a
 * pipeline count the reader cannot act on.
 *
 * Also the Dashboard stats card's visible status line at zero articles, and
 * its toggle's label: one table for both tabs.
 */
export function a11yStateKey(mode: FeedStatusMode): string {
  // Returns a plain string, read by its callers through `tAny`. All four keys exist in
  // all 20 dictionaries, so this is NOT a missing-key workaround: the key is
  // genuinely COMPUTED from `mode`, which is what `tAny` exists for in this
  // file family. Do not "fix" it to a typed `t()` — there is no literal here
  // to type.
  switch (mode) {
    case 'processing':
      return 'feedStatus.modeProcessing';
    case 'error':
      return 'feedStatus.modeError';
    case 'limited':
      return 'feedStatus.modeLimited';
    default:
      return 'feedStatus.idle';
  }
}
