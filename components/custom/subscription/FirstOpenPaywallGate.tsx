import { getSetting } from '@/lib/database/services/setting-service';
import { navigateToPaywall } from '@/lib/nav-state';
import { ROUTE_SETTLE_MS } from './LapseInterstitialGate';
import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';
import {
    aiAccessIsServerResolved,
    deriveHasEverSubscribed,
} from '@/lib/subscription/ai-access';
import { FIRST_OPEN_DISMISSED_SETTING_KEY } from '@/lib/subscription/first-open-dismissal';
import { usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

/**
 * Local, DEVICE-ONLY record that the user dismissed the first-open push.
 *
 * The definition moved to `lib/subscription/first-open-dismissal.ts` once the
 * pre-onboarding paywall gate started reading it too — a lib module must not
 * import a component to get a constant. Re-exported here so every existing
 * importer (and this gate's own tests) keeps working unchanged.
 */
export { FIRST_OPEN_DISMISSED_SETTING_KEY };

/**
 * Shows the paywall the first time a never-subscribed user reaches the app
 * shell without an active plan.
 *
 * Renders nothing. A THIRD mechanism, distinct from the lapse interstitial and
 * from the 402 handling. It routes to the paywall screen in its DEFAULT mode,
 * which is the first-open copy — the one that recommends Starter, because a
 * never-subscribed user has nothing accumulated for Mera News Free to keep yet.
 *
 * It used to be "the most assertive of the three" because the destination
 * auto-presented the purchase sheet on mount. That auto-present has been
 * removed (see NotSubscribedScreen's `presentPaywall`), so this gate now
 * surfaces a PAGE, not a modal. That is still a job worth doing — nothing else
 * brings a never-subscribed user to the plans screen — so the gate stays; only
 * its assertiveness changed.
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
    const hasEverSubscribed = deriveHasEverSubscribed(
        useSubscriptionStore((s) => s.hasEverSubscribed),
    );
    // Subscribed reactively so the effect re-runs the moment the server lands.
    const serverTier = useSubscriptionStore((s) => s.serverTier);

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

        // Never fire on an entitlement OUR SERVER has not resolved.
        //
        // `getAiAccess()` alone is not enough: RevenueCat answers from local
        // cache far sooner than our GraphQL round trip, and an identified-but-
        // empty CustomerInfo yields `'locked'` while `serverTier` is still
        // null. RevenueCat cannot know about the server's free 14-day Starter
        // grant, so acting on that `'locked'` would push a full paywall at a
        // user who is currently entitled — and `hasEverSubscribed` will not
        // save us, because it is deliberately computed from the RAW tier and
        // stays `false` for exactly these users.
        if (!aiAccessIsServerResolved(serverTier)) return;

        // Same reason: 'unknown' is not 'locked'.
        if (getAiAccess() !== 'locked') return;

        // Only from inside the tab shell — not over onboarding, login, or the
        // paywall itself.
        if (!pathname.includes('/logged-in/app_container')) return;

        // Same route-settle wait as the lapse gate, for the same measured
        // reason: the logged-in index replaces into the shell after its async
        // identity work, and a navigation issued inside that window is stomped.
        const timer = setTimeout(() => {
            firedRef.current = true;
            // No `reason` argument: the first-open copy, which recommends
            // Starter. (It no longer also means "and auto-open the sheet".)
            navigateToPaywall();
        }, ROUTE_SETTLE_MS);

        return () => clearTimeout(timer);
    }, [hasEverSubscribed, dismissed, pathname, serverTier]);

    return null;
}
