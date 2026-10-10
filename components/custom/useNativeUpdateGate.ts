import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';

import { isVersionOlder } from '@/lib/algorithms/version-compare';
import { AppVersionService } from '@/lib/app-version-service';
import { FORCE_UPDATE_CHECK_IN_DEV } from '@/lib/config/endpoints';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { isTransientNetworkError } from '@/lib/algorithms/transient-error';
import { getAppVersion } from '@/lib/version';

type GateStatus = 'checking' | 'allowed' | 'blocked';

// Fail-open backstop: if the version check hangs (not a quick network error,
// but a true stall), don't keep the user on the splash forever — let the app
// through. A version that is actually below the floor still gets caught on the
// next foreground check.
const CHECK_TIMEOUT_MS = 4000;

/** NativeUpdateGate's version check: the gate status and the store URL the blocked screen opens. */
export function useNativeUpdateGate() {
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

    return { status, storeUrl };
}

export type { GateStatus };
