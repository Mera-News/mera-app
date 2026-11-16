// The ONE onboarding gate: a settings row, `onboarding_done`, written when the
// wizard finishes. It replaced "zero facts re-enters the wizard": an older
// build let a reader finish with no facts, and that finish stays done, and with
// chat before notifications a user who left after adding facts would never be
// asked about notifications.
//
// Migration, so nobody already through the old wizard sees it again: a device
// with NO row but with facts counts as done, and the row is written then. The
// wizard writes 'false' when it opens (markOnboardingStarted), because step 1
// now saves a fact in one tap: without the marker, a reader who left on the
// sources or notifications step would relaunch with a fact and skip both for good.
//
// Read it only where `hasAnyFacts()` used to be read: AFTER the identity gate's
// wipe succeeded. The row lives in `settings`, which the account-switch wipe
// resets, so a new account starts without it; a failed wipe must never reach
// this read (persona invariant 6b).

import { hasAnyFacts } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

export const ONBOARDING_DONE_SETTING_KEY = 'onboarding_done';

export async function isOnboardingDone(): Promise<boolean> {
    const row = await getSetting(ONBOARDING_DONE_SETTING_KEY);
    if (row === 'true') return true;
    if (row !== null || !(await hasAnyFacts())) return false;
    await markOnboardingDone();
    return true;
}

export async function markOnboardingDone(): Promise<void> {
    await setSetting(ONBOARDING_DONE_SETTING_KEY, 'true');
}

/** The wizard is open: an interrupted run goes back to it, whatever facts it saved. Never overwrites a done row. */
export async function markOnboardingStarted(): Promise<void> {
    if ((await getSetting(ONBOARDING_DONE_SETTING_KEY)) === null) await setSetting(ONBOARDING_DONE_SETTING_KEY, 'false');
}
