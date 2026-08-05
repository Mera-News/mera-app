import { DEV_FORCE_LAPSED } from '@/lib/config/feature-gates';
import { acknowledgeLapseInterstitial } from '@/lib/billing-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { navigateToPaywall } from '@/lib/nav-state';
import {
    DEV_LAPSE_ACK_SETTING_KEY,
    deriveShowLapseInterstitial,
} from '@/lib/subscription/ai-access';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

/**
 * Shows "your Mera plan has ended" exactly once per lapse.
 *
 * Renders nothing — it is a mounted effect, placed once at the logged-in layout
 * root so it observes the whole tree rather than one screen.
 *
 * ## Why "once" is the server's job
 *
 * The latch is `UserBilling.lapseInterstitialShownAt` compared against
 * `lastLapsedAt`, exposed as the `showLapseInterstitial` boolean. A local
 * device flag was the obvious alternative and is wrong twice over: it re-nags
 * after a reinstall, and it cannot re-arm when the user lapses a SECOND time —
 * a boolean that has been set stays set, whereas the timestamp comparison
 * re-arms for free.
 */
/**
 * How long the route must hold still before either gate navigates. Long enough
 * to outlast the logged-in index's async routing, short enough that the user
 * doesn't see the shell and then get moved off it.
 */
export const ROUTE_SETTLE_MS = 900;

export default function LapseInterstitialGate() {
    const pathname = usePathname();
    const serverFlag = useSubscriptionStore((s) => s.showLapseInterstitial);
    const clearLapseInterstitial = useSubscriptionStore((s) => s.clearLapseInterstitial);

    // Dev-only acknowledgement of DEV_FORCE_LAPSED. `null` = not read yet, which
    // must NOT be treated as "not acked" — doing so would fire the interstitial
    // on every launch before the read resolves, which is the exact behaviour
    // this gate exists to prevent.
    const [devAcked, setDevAcked] = useState<boolean | null>(
        __DEV__ && DEV_FORCE_LAPSED ? null : false,
    );

    // Survives re-renders and route changes within one app session, so a
    // pathname change can't fire a second navigation while the ack is in
    // flight. navigateToPaywall has its own guard, but it re-arms as soon as
    // the route settles elsewhere — this one does not.
    const firedRef = useRef(false);

    useEffect(() => {
        if (!__DEV__ || !DEV_FORCE_LAPSED) return;
        let cancelled = false;
        void getSetting(DEV_LAPSE_ACK_SETTING_KEY)
            .then((v) => {
                if (!cancelled) setDevAcked(v === 'true');
            })
            .catch(() => {
                if (!cancelled) setDevAcked(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (firedRef.current || devAcked === null) return;

        if (!deriveShowLapseInterstitial(serverFlag, devAcked)) return;

        // Only from inside the tab shell. Interrupting onboarding, the login
        // flow, or the paywall itself with this would be worse than showing it
        // a moment later — and the user has to reach the shell eventually.
        if (!pathname.includes('/logged-in/app_container')) return;

        // Wait for routing to SETTLE before navigating.
        //
        // Measured on the harness, not theorised: firing immediately sent the
        // ack and issued the replace, and the user still landed on the feed.
        // `app/logged-in/index.tsx` finishes its async identity work and then
        // `router.replace()`s into the shell — a navigation issued inside that
        // window is silently stomped by it, and `firedRef` meant we never tried
        // again. Any pathname change cancels and restarts this timer, so we act
        // only once the route has actually held still.
        const timer = setTimeout(() => {
            firedRef.current = true;

            // Soft mode: explanation first, purchase only on an explicit tap.
            // This user just lost something; opening a purchase sheet in their
            // face is the aggressive-funnel behaviour the tone direction rejects.
            navigateToPaywall('lapsed');

            // Clear locally right away so a re-render can't re-fire, then tell
            // the server. Ack failure is deliberately swallowed — worst case it
            // shows once more on a later launch.
            clearLapseInterstitial();
            void acknowledgeLapseInterstitial();

            if (__DEV__ && DEV_FORCE_LAPSED) {
                // Records the dev acknowledgement so the override stops seeding.
                // Without this, DEV_FORCE_LAPSED would behave as a clamp and the
                // interstitial would reappear on every relaunch — hiding the very
                // "shown once" behaviour it is set to test.
                void setSetting(DEV_LAPSE_ACK_SETTING_KEY, 'true');
                setDevAcked(true);
            }
        }, ROUTE_SETTLE_MS);

        return () => clearTimeout(timer);
    }, [serverFlag, devAcked, pathname, clearLapseInterstitial]);

    return null;
}
