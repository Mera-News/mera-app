import { HStack } from '@/components/ui/hstack';
import { AlertCircleIcon, Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useIsNetworkHealthy, useIsOnline } from '@/lib/stores/network-store';
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
 * Covers three states behind ONE message, because the user's own framing was
 * that the distinction does not matter to them ("the user can even have
 * airplane mode on or can be in a terrible network — doesn't matter"):
 *   - device offline           (NetInfo)
 *   - server unreachable       (consecutive transport failures / probe)
 *   - server slow              (a request past the slow threshold, still running)
 *
 * The copy is deliberately true of all three: "Slow or no connection" does not
 * lie during the slow-but-working case the way "Can't reach Mera" would.
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

    if (!visible) return null;

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
                {t('common.offlineBanner')}
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
