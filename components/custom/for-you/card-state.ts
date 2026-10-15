// Which sentence leads the Feed's counts card when it is not the day's counts
// (owner): ONE lead row (Mera mark, sentence, ⌄) for every state, so the card
// has one layout. RN-free, so it is tested alone.
//
//  - 'limited'  the read hold: when Mera reads again
//  - 'error'    scoring failed: what went wrong (the old red status icon)
//  - 'syncFailed'  a foreground refresh failed or paused offline: the line
//               names the step that worked and the one that did not
//  - 'fetched'  nothing published in the last 24 hours
//  - 'analysed' published, none analysed, and nothing waiting to be (idle):
//               in `deferred` articles ARE waiting, so "couldn't" is untrue
//  - 'relevant' analysed, none relevant
//  - 'offline'  any zero while the device is offline: the reason is the
//               connection, so the card leads with the offline line instead
//
// The limit, then the error, then a failed refresh win over everything. The zeros never show while a
// run is in flight (the statsSync* sentence speaks) or with no facts (the
// no-facts card owns the Feed).

import type { FeedStatusMode } from '@/lib/feed-status-mode';
import type { FeedSyncState, SyncErrorCode } from '@/lib/scheduler/feed-sync/feed-sync-types';

export type SyncFailure =
  | { readonly kind: 'failed'; readonly failedAtState?: FeedSyncState; readonly errorCode?: SyncErrorCode }
  | { readonly kind: 'paused-offline' };

/** The sync message's failure, or null for any other state. */
export function syncFailureOf(
  m: { readonly state: string; readonly failedAtState?: FeedSyncState; readonly errorCode?: SyncErrorCode } | null,
): SyncFailure | null {
  if (m?.state === 'failed') return { kind: 'failed', failedAtState: m.failedAtState, errorCode: m.errorCode };
  return m?.state === 'paused-offline' ? { kind: 'paused-offline' } : null;
}

const FAILED_AT_KEY: Partial<Record<FeedSyncState, string>> = {
  'fetching-topic-ids': 'feed.syncFailed.fetch',
  diffing: 'feed.syncFailed.check',
  hydrating: 'feed.syncFailed.download',
  persisting: 'feed.syncFailed.download',
  scoring: 'feed.syncFailed.score',
};

/** The i18n key of a failure's line; null when another surface owns it (no topics). */
export function syncFailureKey(f: SyncFailure | null): string | null {
  if (!f) return null;
  if (f.kind === 'paused-offline' || f.errorCode === 'offline') return 'common.offlineBannerOffline';
  if (f.errorCode === 'auth-expired') return 'feed.syncFailed.session';
  if (f.errorCode === 'no-topics-configured') return null;
  const at = f.failedAtState;
  if (f.errorCode === 'storage-error' && (at === 'hydrating' || at === 'scoring')) return 'feed.syncFailed.storage';
  return (at && FAILED_AT_KEY[at]) || 'feed.syncFailed.start';
}

/** The limited sentence's key: names the unread articles below only when a
 *  number of them is known and above zero. */
export function readHoldSentenceKey(day: 'today' | 'tomorrow', waiting: number | null) {
  const w = waiting != null && waiting > 0;
  return day === 'today'
    ? w ? ('feed.readHold.waitingToday' as const) : ('feed.readHold.bodyToday' as const)
    : w ? ('feed.readHold.waitingTomorrow' as const) : ('feed.readHold.bodyTomorrow' as const);
}

export type CardState = 'limited' | 'error' | 'syncFailed' | 'fetched' | 'analysed' | 'relevant' | 'offline';

export interface CardStateInput {
  readonly mode: FeedStatusMode;
  readonly noFacts: boolean;
  readonly offline: boolean;
  readonly articleCount: number;
  readonly analysedCount: number;
  readonly relevantCount: number;
  readonly syncFailure: SyncFailure | null;
}

export function cardState(i: CardStateInput): CardState | null {
  if (i.mode === 'limited') return 'limited';
  if (i.mode === 'error') return 'error';
  if (syncFailureKey(i.syncFailure)) return 'syncFailed';
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

/** Whether the Feed has an issue to lead with: the limit, a scoring error, or a failed refresh that has a line. */
export function hasIssue(mode: FeedStatusMode, failure: SyncFailure | null): boolean {
  return mode === 'limited' || mode === 'error' || syncFailureKey(failure) !== null;
}

/** The mark's colour (owner): orange (`accentMark`) when Mera is stuck
 *  (nothing fetched, the daily limit, nothing analysed, a scoring error); the
 *  theme's ink in every other state. */
export type MarkTone = 'alert' | 'normal';
export function markTone(state: CardState | null): MarkTone {
  return state === 'fetched' || state === 'limited' || state === 'analysed' || state === 'error' || state === 'syncFailed' ? 'alert' : 'normal';
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

/** Joins the stats card's sentence parts (each a translated clause or
 *  sentence). Japanese and Chinese write no space after their full stop or
 *  comma, so "。 " would show; every other language takes one space. `lang`
 *  is the UI language (i18next: ja, zh-CN, zh-TW; any zh-* counts). */
export function joinClauses(parts: readonly string[], lang: string | undefined): string {
  const tight = /^(ja|zh)(-|$)/i.test(lang ?? '');
  return parts.join(tight ? '' : ' ');
}
