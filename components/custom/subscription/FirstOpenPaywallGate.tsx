import { getSetting } from '@/lib/database/services/setting-service';
import { navigateToPaywall } from '@/lib/nav-state';
import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';
import { usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

/**
 * Local, DEVICE-ONLY record that the user dismissed the first-open push.
 *
 * Deliberately not server-side, unlike the lapse interstitial. The two look
 * similar and want opposite things:
 *  - the lapse latch exists to AVOID re-nagging a genuine subscriber across
 *    devices and reinstalls after a single-device event, so it must survive;
 *  - this one should reasonably re-arm on a reinstall — a fresh install is a
 *    legitimate second first impression, and the direction here is that
 *    everyone is asked.
 */
export const FIRST_OPEN_DISMISSED_SETTING_KEY = 'companion_first_open_dismissed';

/**
 * Shows the paywall the first time a never-subscribed user reaches the app
 * shell without an active plan.
 *
 * Renders nothing. A THIRD mechanism, distinct from the lapse interstitial and
 * from the 402 handling — and deliberately the most assertive of the three: it
 * is the primary conversion moment, so it routes to the paywall screen in its
 * DEFAULT mode, whose auto-present-on-mount is left exactly as it always was.
 *
 * Mutually exclusive with the lapse gate by construction: this requires
 * `hasEverSubscribed === false`, and a lapse can only happen to someone for
 * whom it is true.
 *
 * Fires at most once per cold start (a ref, not a focus effect) — this is a
 * one-time push, not a recurring nag.
 */
export default function FirstOpenPaywallGate() {
    const pathname = usePathname();
    const hasEverSubscribed = useSubscriptionStore((s) => s.hasEverSubscribed);

    // `null` = the device setting has not been read yet. Must not be treated as
    // "not dismissed": doing so would race the read and re-show the paywall to
    // someone who already dismissed it.
    const [dismissed, setDismissed] = useState<boolean | null>(null);
    const firedRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        void getSetting(FIRST_OPEN_DISMISSED_SETTING_KEY)
            .then((v) => {
                if (!cancelled) setDismissed(v === 'true');
            })
            .catch(() => {
                // Unreadable setting ⇒ assume dismissed. Failing closed here
                // costs a conversion prompt; failing open would re-show the
                // paywall on every launch to a user who already said no.
                if (!cancelled) setDismissed(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (firedRef.current || dismissed === null || dismissed) return;

        // Strictly false, never null: `null` means the server has not answered
        // yet, and pushing a paywall at someone whose plan we simply haven't
        // read is the worst possible false positive.
        if (hasEverSubscribed !== false) return;

        // Same reason: 'unknown' is not 'locked'.
        if (getAiAccess() !== 'locked') return;

        // Only from inside the tab shell — not over onboarding, login, or the
        // paywall itself.
        if (!pathname.includes('/logged-in/app_container')) return;

        firedRef.current = true;
        // No `reason` argument: this deliberately gets the screen's original
        // behaviour, purchase sheet and all.
        navigateToPaywall();
    }, [hasEverSubscribed, dismissed, pathname]);

    return null;
}
