// The reading hold's reset instant as a clock time, in the device's own 12 or
// 24 hour clock. Shared by the counts card and the not-read line.

import { getCalendars } from 'expo-localization';

/** When Mera reads again, in the device's own clock. The cap resets at
 *  00:00 UTC, so "tomorrow" would be false west of UTC. The sync machine
 *  always stores a reset instant; without one (an injected mode, a cleared
 *  store) the next UTC midnight IS the reset, so the sentence never reads
 *  "unlock at .". */
export function limitUnlockTime(resetAt: number | null, now: Date = new Date()): string {
    const at = resetAt ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    let hour12: boolean | undefined;
    try {
        const uses24h = getCalendars()[0]?.uses24hourClock;
        hour12 = uses24h == null ? undefined : !uses24h;
    } catch {
        // No calendar: the locale's own clock.
    }
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });
}
