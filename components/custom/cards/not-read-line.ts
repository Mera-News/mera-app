// The line a not-read card (and the detail screen) shows in its note's place.
// While Mera's reading is held it says why and when Mera reads again (owner);
// otherwise, on-device included, the plain line. Whole sentences per day word,
// never an interpolated "today"/"tomorrow". RN-free.

import { resetDayWord } from '@/lib/subscription/read-hold';

export type NotReadLineKey = 'feed.notRead.line' | 'feed.notRead.heldToday' | 'feed.notRead.heldTomorrow';

export function notReadLineKey(i: { held: boolean; resetAt: number | null; now?: number }): NotReadLineKey {
  if (!i.held || i.resetAt == null) return 'feed.notRead.line';
  return resetDayWord(i.resetAt, i.now ?? Date.now()) === 'today' ? 'feed.notRead.heldToday' : 'feed.notRead.heldTomorrow';
}
