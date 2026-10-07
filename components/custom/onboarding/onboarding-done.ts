// The ONE onboarding gate: a settings row, `onboarding_done`, written when the
// wizard finishes. It replaced "zero facts re-enters the wizard": with
// "Continue without any facts" a factless finish is a real ending, and with
// chat before notifications a user who left after adding facts would never be
// asked about notifications.
//
// Migration, so nobody already through the old wizard sees it again: a device
// with no row but with facts counts as done, and the row is written then.
//
// Read it only where `hasAnyFacts()` used to be read: AFTER the identity gate's
// wipe succeeded. The row lives in `settings`, which the account-switch wipe
// resets, so a new account starts without it; a failed wipe must never reach
// this read (persona invariant 6b).

import { hasAnyFacts } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

export const ONBOARDING_DONE_SETTING_KEY = 'onboarding_done';

export async function isOnboardingDone(): Promise<boolean> {
    if ((await getSetting(ONBOARDING_DONE_SETTING_KEY)) === 'true') return true;
    if (!(await hasAnyFacts())) return false;
    await markOnboardingDone();
    return true;
}

export async function markOnboardingDone(): Promise<void> {
    await setSetting(ONBOARDING_DONE_SETTING_KEY, 'true');
}
