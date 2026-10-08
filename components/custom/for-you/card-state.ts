// Which sentence leads the Feed's counts card when it is not the day's counts
// (owner): ONE lead row (Mera mark, sentence, ⌄) for every state, so the card
// has one layout. RN-free, so it is tested alone.
//
//  - 'limited'  the daily article limit: when new articles unlock
//  - 'error'    scoring failed: what went wrong (the old red status icon)
//  - 'fetched'  nothing published in the last 24 hours
//  - 'analysed' published, none analysed, and nothing waiting to be (idle):
//               in `deferred` articles ARE waiting, so "couldn't" is untrue
//  - 'relevant' analysed, none relevant
//  - 'offline'  any zero while the device is offline: the reason is the
//               connection, so the card leads with the offline line instead
//
// The limit and the error win over everything. The zeros never show while a
// run is in flight (the statsSync* sentence speaks) or with no facts (the
// no-facts card owns the Feed).

import type { FeedStatusMode } from '@/lib/feed-status-mode';

export type CardState = 'limited' | 'error' | 'fetched' | 'analysed' | 'relevant' | 'offline';

export interface CardStateInput {
  readonly mode: FeedStatusMode;
  readonly noFacts: boolean;
  readonly offline: boolean;
  readonly articleCount: number;
  readonly analysedCount: number;
  readonly relevantCount: number;
}

export function cardState(i: CardStateInput): CardState | null {
  if (i.mode === 'limited') return 'limited';
  if (i.mode === 'error') return 'error';
  if (i.noFacts || (i.mode !== 'idle' && i.mode !== 'deferred')) return null;
  const zero: CardState | null =
    i.articleCount === 0
      ? 'fetched'
      : i.analysedCount === 0
        ? i.mode === 'idle'
          ? 'analysed'
          : null
        : i.relevantCount === 0
          ? 'relevant'
          : null;
  return zero && i.offline ? 'offline' : zero;
}

/** The mark's colour (owner): orange (`accentMark`) when Mera is stuck
 *  (nothing fetched, the daily limit, nothing analysed, a scoring error); the
 *  theme's ink in every other state. */
export type MarkTone = 'alert' | 'normal';
export function markTone(state: CardState | null): MarkTone {
  return state === 'fetched' || state === 'limited' || state === 'analysed' || state === 'error' ? 'alert' : 'normal';
}

/** The lead row's Mera mark, by the sentence block's height (owner: about
 *  as big as the text). MeraLogo's `size` IS the drawn glyph's height (its
 *  viewBox is cut to the hexagon and stroke), so the glyph is the block less
 *  MARK_INSET, at MARK_SCALE (owner: 10% smaller), clamped, rounded to 0.5pt. */
const MARK_INSET = 4;
const MARK_SCALE = 0.9;
export const MARK_MIN = 23.5;
export const MARK_MAX = 50.5;
export function markSizeFor(textHeight: number): number {
  const s = Math.round((textHeight - MARK_INSET) * MARK_SCALE * 2) / 2;
  return Math.min(MARK_MAX, Math.max(MARK_MIN, s));
}
