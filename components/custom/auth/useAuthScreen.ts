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
import { useUserStore } from '@/lib/stores/user-store';

import { emailSignInEnded } from './move-to-phone';
import { acceptLegal, fetchLegalVersions, markLegalAcceptedThisProcess, silentlyAcceptLegal } from './legal-consent';

/** The success variant: what a device sign-in hands its caller. */
type DeviceSignInSuccess = Extract<DeviceSignInResult, { status: 'success' }>;

/**
 * The bookkeeping a device sign-in owes the account it signed in, before
 * anything navigates. Mirrors OTPVerificationView's post-verify steps, minus
 * the email cache (an anonymous account has no real address). Every step
 * describes the INCOMING account, which is why it runs only once the user
 * meant this account: when the phone opens a different account than the one
 * on this device, it runs only after the user confirms the switch.
 */
async function completeDeviceSignIn(result: DeviceSignInSuccess): Promise<void> {
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
 * ONE sign-in-with-this-phone path, used by Before you start and by the
 * no-email gate's Try again: sign in, compare with the account on this device
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

/**
 * Where an unsupported phone goes from Before you start. Only the gate (an
 * account with an email) has an email path left; a new user stays put and
 * sees "This phone isn't supported" (email is legacy-only).
 */
function unsupportedExit(cachedEmail: string | null, now?: number): 'reauth-email' | null {
    return cachedEmail && !emailSignInEnded(now) ? 'reauth-email' : null;
}

type Stage =
    | 'loading'
    | 'intro'
    | 'welcome'
    | 'checks'
    | 'begin'
    | 'consent'
    | 'email'
    | 'otp'
    | 'reauth-email'
    | 'email-ended'
    | 'reauth-otp'
    | 'reauth-no-email'
    | 'reauth-mismatch'
    | 'reauth-other-email';

/** Track position, for the slide direction (forward slides left). */
const TRACK: Partial<Record<Stage, number>> = {
    intro: 0,
    welcome: 0,
    checks: 1,
    begin: 2,
    consent: 3,
    email: 4,
    otp: 5,
    'reauth-email': 0,
    'email-ended': 0,
    'reauth-no-email': 0,
    'reauth-otp': 1,
    'reauth-mismatch': 2,
    'reauth-other-email': 3,
};

/** The welcome line holds alone, then the list rises (Journey #3, #4). */
const INTRO_MS = 1200;

interface AuthScreenProps {
    onLoginSuccess?: (userId: string) => void;
    /**
     * Whether device sign-in ("Sign in without email") may be offered. login.tsx
     * passes false on Forgot PIN (`reauth=pin`): device sign-in proves only that
     * someone holds the phone, which is exactly who the PIN guards against.
     */
    allowDeviceSignIn?: boolean;
    /** The clock, for the email cutoff (tests inject it). */
    now?: number;
}

export function useAuthScreen({ onLoginSuccess, allowDeviceSignIn = true, now }: AuthScreenProps) {
    const [stage, setStage] = useState<Stage>('loading');
    const [forward, setForward] = useState(true);
    const [pendingEmail, setPendingEmail] = useState('');
    const [cachedEmail, setCachedEmail] = useState<string | null>(null);
    const [cachedUserId, setCachedUserId] = useState<string | null>(null);
    const [supportId, setSupportId] = useState<string | null>(null);
    const [availability, setAvailability] = useState<DeviceSignInAvailability>('unavailable');
    const [signInPath, setSignInPath] = useState<DeviceSignInPath>('unavailable');
    // Where Before you start was entered from: the track's begin, or the gate.
    const [consentFrom, setConsentFrom] = useState<Stage>('begin');
    // The track's Before you start: 'device' signs in on Agree; 'email' only
    // records the agreement and moves on to the address (Q3).
    const [consentFor, setConsentFor] = useState<'device' | 'email'>('device');
    const [pendingSwitch, setPendingSwitch] = useState<DeviceSignInSuccess | null>(null);
    const [tourOpen, setTourOpen] = useState(false);

    const go = useCallback(
        (next: Stage) => {
            setForward((TRACK[next] ?? 0) >= (TRACK[stage] ?? 0));
            setStage(next);
        },
        [stage],
    );

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // The device facts load independently of the cached rows: a failed settings
                // read must not hide "Begin without email" (it needs only the device).
                const [rows, device] = await Promise.allSettled([
                    Promise.all([
                        getSetting('cached_user_email'),
                        getSetting('cached_user_id'),
                        getSetting('cached_support_id'),
                    ]),
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
                const [email, userId, sid] = rows.value;
                setCachedUserId(userId ?? null);
                setSupportId(sid ?? null);
                if (email && userId) {
                    setCachedEmail(email);
                    setStage(emailSignInEnded(now) ? 'email-ended' : 'reauth-email');
                } else if (userId) {
                    setStage('reauth-no-email');
                } else {
                    setStage('intro');
                }
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
        if (!stage.startsWith('reauth') && stage !== 'email-ended') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (stage === 'reauth-otp' || stage === 'reauth-mismatch') {
                go(cachedEmail ? 'reauth-email' : 'reauth-no-email');
                return true;
            }
            if (stage === 'reauth-other-email') {
                go('reauth-mismatch');
                return true;
            }
            BackHandler.exitApp();
            return true;
        });
        return () => sub.remove();
    }, [stage, go, cachedEmail]);

    // ── Handlers ──────────────────────────────────────────────────────────
    const emailEnded = emailSignInEnded(now);
    const canSignInWithoutEmail = allowDeviceSignIn && availability !== 'unavailable';

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

    const handleVerificationSuccess = (userId: string) => {
        // The address step came after Before you start, so the agreement is
        // the user's own; stamp it now that a session exists to stamp it with.
        void silentlyAcceptLegal(userId);
        setPendingEmail('');
        onLoginSuccess?.(userId);
    };

    const handleSwitchContinue = async () => {
        if (!pendingSwitch) return;
        releaseAccountSwitch();
        await completeDeviceSignIn(pendingSwitch);
        finishDeviceSignIn(pendingSwitch);
    };

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
        setConsentFor,
        setConsentFrom,
        setPendingEmail,
        pendingEmail,
        cachedEmail,
        cachedUserId,
        supportId,
        availability,
        signInPath,
        consentFor,
        consentFrom,
        pendingSwitch,
        tourOpen,
        setTourOpen,
        canSignInWithoutEmail,
        emailEnded,
        finishDeviceSignIn,
        askSwitch,
        handleVerificationSuccess,
        handleSwitchContinue,
        handleSwitchKeep,
    };
}

export { signInWithPhone, unsupportedExit };
export type { AuthScreenProps, DeviceSignInSuccess, Stage };
