import { HStack } from '@/components/ui/hstack';
import { AlertCircleIcon, Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
    probeInternetReachable,
    useIsConnected,
    useIsNetworkHealthy,
    useIsOnline,
    useNetworkStore,
} from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Delay before the band paints. A brief blip — a tunnel, a handover, one slow
 * request — must not flash a warning at the user.
 */
export const SHOW_DELAY_MS = 2_000;

/**
 * Global connectivity band.
 *
 * Covers three UNHEALTHY states, forked into three messages — this used to be
 * ONE message for all of them (the user's own framing was that the
 * distinction didn't matter: "the user can even have airplane mode on or can
 * be in a terrible network — doesn't matter"), but that framing conflated two
 * genuinely different problems with different fixes: the user's own network
 * versus Mera being down. Blaming Mera for a captive portal (or the reverse)
 * sends the user to fix the wrong thing. The three:
 *   - device offline           (NetInfo `isConnected: false`) → user's device
 *   - link up, internet down   (neutral probe fails — captive portal / DNS
 *                                hijack) → user's network, NOT Mera
 *   - internet fine, Mera down (server unreachable, or merely slow) → Mera
 *
 * The middle state is the genuinely NEW information here: `isConnected` alone
 * cannot tell "there is a link" apart from "that link actually reaches the
 * open internet" — see `probeInternetReachable()` in network-store.ts.
 *
 * Not dismissible: it self-clears the instant connectivity returns, so a
 * dismiss control would only be a way to hide a true statement. (ReauthBanner
 * is dismissible because it is ACTIONABLE — this one is pure information.)
 *
 * Mounted once at the root layout so it covers /login and /pin-lock too — the
 * "Welcome back" screen this whole wave is about lives at /login, which the
 * /logged-in banner slot cannot reach.
 */
const OfflineBanner: React.FC = () => {
    const { t } = useTranslation();
    const healthy = useIsNetworkHealthy();
    const reachable = useIsOnline();
    const isConnected = useIsConnected();
    const internetReachable = useNetworkStore((s) => s.internetReachable);
    const needsReauth = useUserStore((s) => s.needsReauth);
    const [visible, setVisible] = useState(false);

    // Collision guard. Both bands are absolutely positioned at the same
    // coordinates (top: insets.top + 8, zIndex 20) and this one is mounted at the
    // ROOT, so it paints over the /logged-in slot — it would hide ReauthBanner
    // rather than sit beside it.
    //
    // Only suppress in the SLOW-ONLY case: connected + reachable, i.e. the sole
    // reason we would paint is `serverSlow`. There, re-auth is perfectly
    // completable and the actionable banner must win. When the server is
    // genuinely unreachable, ReauthBanner hides itself (it gates on useIsOnline),
    // so there is no collision and this band is the correct thing to show.
    const yieldToReauthBanner = needsReauth && reachable;

    useEffect(() => {
        // Asymmetric on purpose: delayed show, INSTANT hide. Lingering on a
        // "we can't connect" message while the feed is visibly loading is worse
        // than never having shown it.
        if (healthy || yieldToReauthBanner) {
            setVisible(false);
            return;
        }
        const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
        return () => clearTimeout(timer);
    }, [healthy, yieldToReauthBanner]);

    // Disambiguate WHY, once per unhealthy episode. A confirmed-offline device
    // already has its answer (`isConnected === false`) and isn't worth a round
    // trip. Anything else that's still unhealthy but HAS a link — server
    // unreachable, or merely slow — is exactly the case the neutral probe
    // exists for: without it, a captive portal / DNS hijack reads identically
    // to "Mera is down" and would tell the user to fix the wrong thing. Keyed
    // on `isConnected` too (not just `healthy`) so a device that reconnects
    // mid-episode gets a fresh verdict instead of reusing a stale one from
    // before it dropped.
    useEffect(() => {
        if (healthy || !isConnected) return;
        void probeInternetReachable();
    }, [healthy, isConnected]);

    if (!visible) return null;

    const messageKey = !isConnected
        ? 'common.offlineBannerOffline'
        : !internetReachable
            ? 'common.offlineBannerInternetDown'
            : 'common.offlineBannerServerDown';

    return (
        <HStack
            testID="offline-banner"
            className="items-center bg-warning-900 rounded-lg px-3 py-2"
            space="sm"
            // Purely informational — must never swallow a pull-to-refresh
            // starting underneath it.
            pointerEvents="none"
        >
            <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
            <Text size="sm" className="text-warning-400">
                {t(messageKey)}
            </Text>
        </HStack>
    );
};

/**
 * Absolutely-positioned host for the band, mounted once by the root layout.
 *
 * The insets hook lives HERE rather than in the root layout so that layout gains
 * no new subscription — a re-render of this slot can never re-render the route
 * tree above it. Same geometry as the /logged-in ReauthBanner slot, so the two
 * read as one system.
 */
export const OfflineBannerSlot: React.FC = () => {
    const insets = useSafeAreaInsets();
    return (
        <View
            pointerEvents="box-none"
            style={{
                position: 'absolute',
                top: insets.top + 8,
                left: 16,
                right: 16,
                zIndex: 20,
            }}
        >
            <OfflineBanner />
        </View>
    );
};

export default OfflineBanner;
