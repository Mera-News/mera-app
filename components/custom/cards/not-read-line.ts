// The line a not-read card (and the detail screen) shows in its note's place.
// While Mera's reading is held it says why and when Mera reads again (owner);
// otherwise, on-device included, the plain line. Whole sentences per day word,
// never an interpolated "today"/"tomorrow". RN-free.
//
// Also the held NOTE line: a scored row whose note waits for the reading
// hold to lift says when Mera writes it.

import { resetDayWord } from '@/lib/subscription/read-hold';

export type NotReadLineKey = 'feed.notRead.line' | 'feed.notRead.heldToday' | 'feed.notRead.heldTomorrow';

export function notReadLineKey(i: { held: boolean; resetAt: number | null; now?: number }): NotReadLineKey {
  if (!i.held || i.resetAt == null) return 'feed.notRead.line';
  return resetDayWord(i.resetAt, i.now ?? Date.now()) === 'today' ? 'feed.notRead.heldToday' : 'feed.notRead.heldTomorrow';
}

/** The hold's reset instant. Reading resets at 00:00 UTC, so without one (an
 *  injected mode, a cleared store) the next UTC midnight IS the reset. The
 *  day word and the clock time (`limitUnlockTime`) both read this. */
export function nextResetAt(resetAt: number | null, now: number = Date.now()): number {
  if (resetAt != null) return resetAt;
  const n = new Date(now);
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
}

export type NoteHeldLineKey = 'feed.noteHeldToday' | 'feed.noteHeldTomorrow';

/** The line a pending note shows while the reading hold is set. */
export function noteHeldLineKey(i: { resetAt: number | null; now?: number }): NoteHeldLineKey {
  const now = i.now ?? Date.now();
  return resetDayWord(nextResetAt(i.resetAt, now), now) === 'today' ? 'feed.noteHeldToday' : 'feed.noteHeldTomorrow';
}
