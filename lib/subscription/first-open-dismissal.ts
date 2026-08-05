// The device-local "I said no to the first-open paywall" flag.
//
// Extracted to its own leaf module (it used to live in FirstOpenPaywallGate.tsx)
// because TWO surfaces now read it: that gate, and the pre-onboarding paywall
// decision in `onboarding-paywall.ts`. A lib module must not import a component
// to get a constant, and duplicating the string would be worse.
//
// Deliberately not server-side, unlike the lapse latch. The two look similar and
// want opposite things:
//  - the lapse latch exists to AVOID re-nagging a genuine subscriber across
//    devices and reinstalls after a single-device event, so it must survive;
//  - this one should reasonably re-arm on a reinstall — a fresh install is a
//    legitimate second first impression, and the direction here is that everyone
//    is asked.

import { getSetting } from '@/lib/database/services/setting-service';

export const FIRST_OPEN_DISMISSED_SETTING_KEY = 'free_tier_first_open_dismissed';

/**
 * Has this device already dismissed the first-open paywall?
 *
 * FAILS CLOSED (`true`) on an unreadable setting, matching FirstOpenPaywallGate:
 * failing closed costs one conversion prompt; failing open would re-show the
 * paywall on every launch to a user who already said no — and, on the
 * pre-onboarding path, would trap them in a paywall → dismiss → paywall loop.
 */
export async function readFirstOpenDismissed(): Promise<boolean> {
    try {
        return (await getSetting(FIRST_OPEN_DISMISSED_SETTING_KEY)) === 'true';
    } catch {
        return true;
    }
}
