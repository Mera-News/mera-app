import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';

import { clearAuthStorage } from '@/lib/auth-client';
import { getSetting } from '@/lib/database/services/setting-service';
import {
    deviceSignInAvailability,
    deviceSignInPath,
    signInWithDevice,
    type DeviceSignInAvailability,
    type DeviceSignInFailureReason,
    type DeviceSignInPath,
    type DeviceSignInResult,
} from '@/lib/device-auth';
import {
    clearIdentityFault,
    holdAccountSwitch,
    recordAuthenticatedUser,
    releaseAccountSwitch,
} from '@/lib/security/identity-gate';
import { hapticLight } from '@/lib/haptics';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useUserStore } from '@/lib/stores/user-store';

import { acceptLegal, fetchLegalVersions, markLegalAcceptedThisProcess } from './legal-consent';

/** The success variant: what a device sign-in hands its caller. */
type DeviceSignInSuccess = Extract<DeviceSignInResult, { status: 'success' }>;

/**
 * The bookkeeping a device sign-in owes the account it signed in, before
 * anything navigates. Every step
 * describes the INCOMING account, which is why it runs only once the user
 * meant this account: when the phone opens a different account than the one
 * on this device, it runs only after the user confirms the switch.
 */
export async function completeDeviceSignIn(result: DeviceSignInSuccess): Promise<void> {
    recordAuthenticatedUser(result.userId);
    useUserStore.getState().setNeedsReauth(false);
    clearIdentityFault().catch(() => {});
    // Consent is a fact about what the user just did (they tapped Agree, or
    // already had an account): latch FIRST, then the network work. A failed
    // write is ConsentGate's to retry silently, never grounds to re-ask.
    markLegalAcceptedThisProcess(result.userId);
    const versions = await fetchLegalVersions();
    if (versions) await acceptLegal(versions);
}

type PhoneSignIn =
    | { kind: 'signed-in'; result: DeviceSignInSuccess }
    | { kind: 'different'; result: DeviceSignInSuccess }
    | { kind: 'unsupported' }
    | { kind: 'failed'; reason: DeviceSignInFailureReason };

/**
 * ONE sign-in-with-this-phone path, used by Before you start: sign in, compare with the account on this device
 * BEFORE any bookkeeping, and only then complete. A mismatch writes nothing;
 * the caller takes holdAccountSwitch synchronously and asks (the session
 * cookie is already set, and the watcher, the onboarding gate and login.tsx's
 * shortcut would otherwise wipe this device's account unasked).
 */
async function signInWithPhone(expectedUserId: string | null): Promise<PhoneSignIn> {
    // Every attempt re-enters the whole flow, so it always fetches a fresh nonce.
    const result = await signInWithDevice();
    if (result.status === 'success') {
        if (expectedUserId && result.userId !== expectedUserId) return { kind: 'different', result };
        await completeDeviceSignIn(result);
        return { kind: 'signed-in', result };
    }
    if (result.status === 'unsupported') return { kind: 'unsupported' };
    return { kind: 'failed', reason: result.reason };
}

type Stage = 'loading' | 'intro' | 'welcome' | 'consent' | 'reauth-no-email';

/** Track position, for the slide direction (forward slides left). */
const TRACK: Partial<Record<Stage, number>> = {
    intro: 0,
    welcome: 0,
    consent: 1,
    'reauth-no-email': 0,
};

/** The welcome line holds alone, then the list rises (Journey #3, #4). */
const INTRO_MS = 1200;

interface AuthScreenProps {
    onLoginSuccess?: (userId: string) => void;
}

export function useAuthScreen({ onLoginSuccess }: AuthScreenProps) {
    const [stage, setStage] = useState<Stage>('loading');
    const [forward, setForward] = useState(true);
    const [cachedUserId, setCachedUserId] = useState<string | null>(null);
    const [supportId, setSupportId] = useState<string | null>(null);
    const [availability, setAvailability] = useState<DeviceSignInAvailability>('unavailable');
    const [signInPath, setSignInPath] = useState<DeviceSignInPath>('unavailable');
    const [pendingSwitch, setPendingSwitch] = useState<DeviceSignInSuccess | null>(null);
    const [tourOpen, setTourOpen] = useState(false);

    const go = useCallback(
        (next: Stage) => {
            setForward((TRACK[next] ?? 0) >= (TRACK[stage] ?? 0));
            setStage(next);
        },
        [stage],
    );

    // ONE Get started: the Get started button and the welcome tour's finish both run it.
    const [starting, setStarting] = useState(false);
    const getStarted = useCallback(async () => {
        if (starting) return;
        setStarting(true);
        void hapticLight();
        try {
            // Persist the language row even when the reader kept the default:
            // the choice is a fact about this install from now on.
            await useAppLanguageStore.getState().setAppLanguage(useAppLanguageStore.getState().appLanguage);
        } catch {
            // The store already logged it; the reader still moves on.
        }
        setStarting(false);
        go('consent');
    }, [starting, go]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // The device facts load independently of the cached rows: a failed settings
                // read must not hide "Sign in with this phone" (it needs only the device).
                const [rows, device] = await Promise.allSettled([
                    Promise.all([getSetting('cached_user_id'), getSetting('cached_support_id')]),
                    Promise.all([deviceSignInAvailability(), deviceSignInPath()]),
                ]);
                if (cancelled) return;
                if (device.status === 'fulfilled') {
                    setAvailability(device.value[0]);
                    setSignInPath(device.value[1]);
                }
                if (rows.status === 'rejected') {
                    setStage('intro');
                    return;
                }
                const [userId, sid] = rows.value;
                setCachedUserId(userId ?? null);
                setSupportId(sid ?? null);
                setStage(userId ? 'reauth-no-email' : 'intro');
            } catch {
                if (!cancelled) setStage('intro');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (stage !== 'intro') return;
        const id = setTimeout(() => setStage('welcome'), INTRO_MS);
        return () => clearTimeout(id);
    }, [stage]);

    // The gate leaves the app on Android Back (FinalStart #9): there is nothing
    // behind it to go back to.
    useEffect(() => {
        if (stage !== 'reauth-no-email') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            BackHandler.exitApp();
            return true;
        });
        return () => sub.remove();
    }, [stage]);

    // ── Handlers ──────────────────────────────────────────────────────────
    const finishDeviceSignIn = (result: DeviceSignInSuccess) => {
        if (onLoginSuccess) {
            onLoginSuccess(result.userId);
            return;
        }
        // better-auth's atom may settle late after a custom $fetch route, so
        // navigate rather than wait on login.tsx's session Redirect.
        router.replace('/logged-in');
    };

    const askSwitch = (result: DeviceSignInSuccess) => {
        // Synchronously, before the atom can settle on the phone's account.
        holdAccountSwitch(result.userId);
        setPendingSwitch(result);
    };

    const handleSwitchContinue = async () => {
        if (!pendingSwitch) return;
        releaseAccountSwitch();
        await completeDeviceSignIn(pendingSwitch);
        finishDeviceSignIn(pendingSwitch);
    };

    // Reset this phone: cached_user_id is gone, so this screen is the sign-in
    // track now. Set here as well as by the remount, which a replace onto the
    // same route is not guaranteed to do.
    const leaveGate = useCallback(() => {
        setCachedUserId(null);
        setSupportId(null);
        setForward(true);
        setStage('intro');
    }, []);

    // Declined: the phone's account signed in but nothing was recorded for
    // it. Sign it out through the one sign-out path and stay where we were.
    const handleSwitchKeep = async () => {
        await clearAuthStorage();
        setPendingSwitch(null);
    };

    return {
        stage,
        forward,
        go,
        cachedUserId,
        supportId,
        availability,
        signInPath,
        pendingSwitch,
        tourOpen,
        setTourOpen,
        getStarted,
        starting,
        finishDeviceSignIn,
        askSwitch,
        handleSwitchContinue,
        handleSwitchKeep,
        leaveGate,
    };
}

export { signInWithPhone };
export type { AuthScreenProps, DeviceSignInSuccess, Stage };
