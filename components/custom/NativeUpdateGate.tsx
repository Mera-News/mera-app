import { ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import ForceUpdateScreen from '@/components/custom/ForceUpdateScreen';
import { useNativeUpdateGate } from '@/components/custom/useNativeUpdateGate';
import { releaseSplash } from '@/lib/splash-hold';
import { useColors } from '@/lib/theme/tokens';

/**
 * Mandatory-update gate — the app's FIRST-priority gate, ahead of the payment /
 * subscription gate. It resolves the version check BEFORE rendering the app, so
 * an out-of-date install goes straight to the update screen and never sees the
 * paywall/approval flow underneath.
 *
 * - checking → neutral splash; the app (and its other gates) does not render yet.
 * - blocked  → ONLY the ForceUpdateScreen renders; the rest of the tree is
 *              unmounted and AppScheduler is suspended (no background work).
 * - allowed  → renders the app normally; OTA / store auto-update handle the rest.
 *
 * Best-effort and fails open: a transient/stalled check never blocks a user
 * whose version is actually fine. Skipped in dev builds unless
 * EXPO_PUBLIC_FORCE_UPDATE_IN_DEV=true; always runs in release builds.
 */
export default function NativeUpdateGate({ children }: { children: ReactNode }) {
    const { status, storeUrl } = useNativeUpdateGate();
    const c = useColors();

    if (status === 'blocked') {
        // The update screen replaces the app, so no route will ever release
        // the held splash (lib/splash-hold.ts). Release it here instead.
        releaseSplash('force-update');
        return <ForceUpdateScreen storeUrl={storeUrl} />;
    }

    if (status === 'checking') {
        // Neutral black splash while we decide, so the paywall/approval flow
        // never flashes ahead of an update.
        //
        // DELIBERATELY has no AbstractGradientBackdrop, unlike ForceUpdateScreen
        // below it: this is the cold-start path — the same exemption as
        // app/index.tsx and app/logged-in/index.tsx — and mounting a reanimated
        // + svg animation for the few hundred ms of a version check would pull
        // that graph in ahead of the app itself. Not an oversight; don't "fix" it.
        return (
            <View className="flex-1 bg-page items-center justify-center">
                <ActivityIndicator size="small" color={c.ink} />
            </View>
        );
    }

    return <>{children}</>;
}
