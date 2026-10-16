// The reading hold's reset instant as a clock time. Shared by the counts card
// and the not-read line; the clock rule itself (the device's 12/24h setting)
// is ONE helper, `formatClockTime`, shared with the reading meter.

import { nextResetAt } from '@/components/custom/cards/not-read-line';
import { formatClockTime } from '@/lib/subscription/clock-time';

/** When Mera reads again, in the device's own clock. Reading resets at
 *  00:00 UTC, so "tomorrow" would be false west of UTC. Without a reset
 *  instant (an injected mode, a cleared store) the next UTC midnight IS the
 *  reset, so the sentence never reads "again at .". */
export function limitUnlockTime(resetAt: number | null, now: Date = new Date()): string {
    return formatClockTime(nextResetAt(resetAt, now.getTime())) ?? '';
}
