// read-snapshot — "has the reader read this story?" as a pure value, for the
// 7-day keep of unread High and Emergency rows (D7, D14, D21).
//
// Read = OPENED (the opened-stories set: article ids and stable cluster ids)
// or VIEWED on the Feed (card state 'viewed'). A 'skipped' card, dwelt past
// without a touch, is still unread. Nothing here records anything new.
//
// STORY level, not row level: card states are keyed by the feed-order row id,
// which is the representative's article id at first ingest. Checking rows
// alone left a viewed story's siblings unread, kept for 7 days, and back as a
// fresh card once the viewed representative aged out. So every read article
// found among `rows` also marks its story: its top stable cluster id (the
// order store's rep-switch key) and its server `storyKey` (the edge story
// grouping always unions).
//
// DB-FREE on purpose: fact-rows-selector and its unit suites must never reach
// SQLite. Callers read the `feed_card_state_v1` setting themselves and hand
// the blob to `parseCardState`.

import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** Compact wire encoding for a state record: `['s' | 'v', epochMs]`. */
type WireState = ['s' | 'v', number];

/** Defensive parse of the persisted `feed_card_state_v1` blob. A device that has
 *  never written the key, or wrote a malformed one, gets an empty map: every
 *  card back at unviewed, the safe direction (shows more, hides nothing).
 *
 *  Older blobs also carry a `tombs` map from the removed eviction mechanism. It
 *  is ignored and never re-serialized, so it goes inert on the next write. */
export function parseCardState(raw: string | null): Record<string, CardStateRecord> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const rawStates = (parsed as { states?: unknown }).states;
  if (!rawStates || typeof rawStates !== 'object') return {};

  const states: Record<string, CardStateRecord> = {};
  for (const [id, v] of Object.entries(rawStates as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length !== 2) continue;
    const [code, at] = v as WireState;
    if (code !== 's' && code !== 'v') continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    states[id] = { state: code === 'v' ? 'viewed' : 'skipped', at };
  }
  return states;
}

type StoryRow = Pick<ForYouSuggestion, 'articleId' | 'clusters' | 'storyKey'>;

/** Every key a read story is known by: article ids, stable cluster ids and
 *  `sk:`-prefixed story keys. */
export interface ReadSnapshot {
  readonly readKeys: ReadonlySet<string>;
}

function topStableClusterId(s: StoryRow): string | null {
  return s.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;
}

/**
 * Build the snapshot. `opened` is the opened-stories set (article ids plus
 * stable cluster ids, `getOpenedSeenSet` / `useOpenedStoriesStore.ids`);
 * `rows` are the suggestions the caller is about to judge, used to lift a read
 * article to its story.
 */
export function buildReadSnapshot(
  cardStates: Record<string, CardStateRecord>,
  opened: Iterable<string>,
  rows: Iterable<StoryRow>,
): ReadSnapshot {
  const readKeys = new Set<string>(opened);
  for (const id in cardStates) if (cardStates[id].state === 'viewed') readKeys.add(id);
  const snap = { readKeys };
  // One pass: a row read by any key lends the story its other keys.
  for (const r of rows) {
    if (!isReadStory(r, snap)) continue;
    const scid = topStableClusterId(r);
    if (scid) readKeys.add(scid);
    if (r.storyKey) readKeys.add(`sk:${r.storyKey}`);
  }
  return snap;
}

/** True when any key of this row's story was read. */
export function isReadStory(s: StoryRow, snap: ReadSnapshot): boolean {
  const k = snap.readKeys;
  if (s.articleId && k.has(s.articleId)) return true;
  const scid = topStableClusterId(s);
  if (scid && k.has(scid)) return true;
  return !!s.storyKey && k.has(`sk:${s.storyKey}`);
}
