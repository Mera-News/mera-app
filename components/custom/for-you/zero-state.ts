// Which sentence leads the Feed's counts card when a count is zero (owner):
// the card says why instead of going silent. RN-free, so it is tested alone.
//
//  - 'fetched'  nothing published in the last 24 hours
//  - 'analysed' published, none analysed, and nothing waiting to be (idle):
//               in `deferred` articles ARE waiting, so "couldn't" is untrue
//  - 'relevant' analysed, none relevant
//  - 'offline'  any of those while the device is offline: the reason is the
//               connection, so the card leads with the offline line instead
//
// Never while a run is in flight (the statsSync* sentence speaks), never on
// the daily limit or an error (FeedStatusNotice owns the card), never with no
// facts (the no-facts card owns it).

import type { FeedStatusMode } from '@/lib/feed-status-mode';

export type ZeroState = 'fetched' | 'analysed' | 'relevant' | 'offline';

export interface ZeroStateInput {
  readonly mode: FeedStatusMode;
  readonly noFacts: boolean;
  readonly offline: boolean;
  readonly articleCount: number;
  readonly analysedCount: number;
  readonly relevantCount: number;
}

export function zeroState(i: ZeroStateInput): ZeroState | null {
  if (i.noFacts || (i.mode !== 'idle' && i.mode !== 'deferred')) return null;
  const zero: ZeroState | null =
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
