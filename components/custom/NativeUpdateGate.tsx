import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, AppStateStatus, Platform, View } from 'react-native';

import ForceUpdateScreen from '@/components/custom/ForceUpdateScreen';
import { AppVersionService } from '@/lib/app-version-service';
import { FORCE_UPDATE_CHECK_IN_DEV } from '@/lib/config/endpoints';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { isTransientNetworkError } from '@/lib/utils/transient-error';
import { getAppVersion, isVersionOlder } from '@/lib/version';

type GateStatus = 'checking' | 'allowed' | 'blocked';

// Fail-open backstop: if the version check hangs (not a quick network error,
// but a true stall), don't keep the user on the splash forever — let the app
// through. A version that is actually below the floor still gets caught on the
// next foreground check.
const CHECK_TIMEOUT_MS = 4000;

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
    const skip =
        (__DEV__ && !FORCE_UPDATE_CHECK_IN_DEV) ||
        (Platform.OS !== 'ios' && Platform.OS !== 'android');

    const [status, setStatus] = useState<GateStatus>(skip ? 'allowed' : 'checking');
    const [storeUrl, setStoreUrl] = useState<string | null>(null);
    // Whether the first decision (allowed/blocked) has been made. Guards the
    // re-foreground re-check from flipping a settled gate back to 'checking'.
    const settledRef = useRef(skip);
    // Once blocked we never re-check — the screen stays static and no further
    // queries/state updates fire (the user can only resolve this by updating).
    const blockedRef = useRef(false);

    const checkVersion = useCallback(async () => {
        if (blockedRef.current) return;
        try {
            const info = await AppVersionService.getVersionInfo();
            const min = info?.minSupportedVersion;
            if (min && isVersionOlder(getAppVersion(), min)) {
                blockedRef.current = true;
                settledRef.current = true;
                setStoreUrl(info?.storeUrl ?? null);
                setStatus('blocked');
                // Hard-stop all background work for the rest of this session.
                AppScheduler.suspend();
                return;
            }
        } catch (error) {
            if (!isTransientNetworkError(error)) {
                logger.captureException(error as Error, {
                    tags: { component: 'NativeUpdateGate', method: 'checkVersion' },
                });
            }
            // Fall through and fail open.
        }

        if (!settledRef.current) {
            settledRef.current = true;
            setStatus('allowed');
        }
    }, []);

    useEffect(() => {
        if (skip) return;

        checkVersion();

        // Don't strand the user on the splash if the check stalls.
        const timer = setTimeout(() => {
            if (!settledRef.current) {
                settledRef.current = true;
                setStatus('allowed');
            }
        }, CHECK_TIMEOUT_MS);

        const handleAppStateChange = (state: AppStateStatus) => {
            if (state === 'active') checkVersion();
        };
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            clearTimeout(timer);
            subscription.remove();
        };
    }, [skip, checkVersion]);

    if (status === 'blocked') {
        return <ForceUpdateScreen storeUrl={storeUrl} />;
    }

    if (status === 'checking') {
        // Neutral black splash (matches the app background) while we decide,
        // so the paywall/approval flow never flashes ahead of an update.
        return (
            <View className="flex-1 bg-black items-center justify-center">
                <ActivityIndicator size="small" color="#FFFFFF" />
            </View>
        );
    }

    return <>{children}</>;
}
