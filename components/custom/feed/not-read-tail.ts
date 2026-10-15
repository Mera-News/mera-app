// not-read-tail — the Continuous view's articles Mera has not read yet.
//
// Every article reaches the Feed; plans meter only Mera's cloud reading. A
// story whose elected representative is `unscored` (so EVERY member is: a
// scored member always fronts, see feed-list-selector's `statusRank`) is a
// NOT-READ card. Those cards come after every scored card, in every seen
// tier, newest published first.
//
// They NEVER enter `feed-order-store`. The store is insert-only (invariant 4),
// and most of a fetch scores below the gate, so a not-read row ingested there
// would linger as a stale card until the next hydrate. Instead the tail is a
// SESSION list here: its membership is fixed for the reading session
// (`resetSession` starts a new one), so nothing jumps under a reader of the
// tail. Within a session:
//   - a tail row that Mera then reads stays in place, showing its new state
//     (the card renders the article's live row); it rises into its band, or
//     drops out, at the next session;
//   - a story that Mera reads and that now fronts a SCORED candidate sharing a
//     member with a tail row is withheld from the scored list and from ingest
//     until then, so one story never shows twice;
//   - not-read stories that arrive mid-session are appended at the end,
//     newest first among themselves.
// The tail is capped at TAIL_RENDER_CAP rows (the newest at session start);
// the waiting count is always the true number of articles.
//
// PURE: no React, no store, no database.

import { isNotRead } from '@/lib/feed-ordering/pending-visibility';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';

/** At most this many not-read cards render (owner, W14). */
export const TAIL_RENDER_CAP = 200;

export interface NotReadTailSession {
  /** Tail row ids in render order. */
  readonly ids: string[];
  /** The latest item seen for each tail id (kept when it leaves the pool). */
  readonly items: Map<string, FeedListItem>;
}

export function newNotReadTailSession(): NotReadTailSession {
  return { ids: [], items: new Map() };
}

export interface FoldedTail {
  /** The tail rows to render, in order. */
  readonly tail: FeedListItem[];
  /** Candidate ids kept out of the scored list and out of ingest this
   *  session: tail ids that Mera read, and scored stories sharing a member
   *  with a tail row. */
  readonly withheld: ReadonlySet<string>;
  /** Articles Mera has not read among the candidates that would be tail
   *  rows: the TRUE count, never capped. */
  readonly notReadArticles: number;
}

function pubMs(it: FeedListItem): number {
  const t = Date.parse(it.suggestion.firstPubDate ?? '');
  return Number.isFinite(t) ? t : 0;
}

/** Newest published first; id breaks a tie. */
export function newestFirst(a: FeedListItem, b: FeedListItem): number {
  return pubMs(b) - pubMs(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Fold this render's candidates into the session's tail. Mutates `session`
 * (idempotent for the same candidates, so a double render is safe), the same
 * contract as feed-row-display's `resolveFeedRowDisplay`.
 */
export function foldNotReadTail(
  session: NotReadTailSession,
  candidates: readonly FeedListItem[],
  cap: number = TAIL_RENDER_CAP,
): FoldedTail {
  const inTail = new Set(session.ids);
  const fresh: FeedListItem[] = [];
  let notReadArticles = 0;
  for (const it of candidates) {
    if (inTail.has(it.id)) {
      session.items.set(it.id, it);
    } else if (isNotRead(it.suggestion)) {
      fresh.push(it);
    }
    if (isNotRead(it.suggestion)) notReadArticles += it.memberCount;
  }
  if (fresh.length > 0 && session.ids.length < cap) {
    fresh.sort(newestFirst);
    for (const it of fresh.slice(0, cap - session.ids.length)) {
      session.ids.push(it.id);
      session.items.set(it.id, it);
      inTail.add(it.id);
    }
  }

  // Member ids the tail holds: a scored story sharing one is the same story.
  const tailMembers = new Set<string>();
  for (const id of session.ids) {
    for (const m of session.items.get(id)?.memberIds ?? []) tailMembers.add(m);
  }
  const withheld = new Set<string>();
  for (const it of candidates) {
    if (inTail.has(it.id)) {
      withheld.add(it.id);
      continue;
    }
    if (isNotRead(it.suggestion)) continue; // a not-read story past the cap
    if (it.memberIds.some((m) => tailMembers.has(m))) withheld.add(it.id);
  }

  const tail: FeedListItem[] = [];
  for (const id of session.ids) {
    const it = session.items.get(id);
    if (it) tail.push(it);
  }
  return { tail, withheld, notReadArticles };
}

/** The Show filter (feed-view-prefs `feed_show`). */
export type FeedShow = 'all' | 'picks' | 'unread';

/** What the list renders for a filter: Mera's picks, then the tail. `picks`
 *  is how many leading rows are scored (the divider sits after them). */
export function applyFeedShow(
  scored: readonly FeedListItem[],
  tail: readonly FeedListItem[],
  show: FeedShow,
): { rows: FeedListItem[]; picks: number } {
  if (show === 'picks') return { rows: [...scored], picks: scored.length };
  if (show === 'unread') return { rows: [...tail], picks: 0 };
  return { rows: [...scored, ...tail], picks: scored.length };
}
