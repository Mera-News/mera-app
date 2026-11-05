import { AppState } from 'react-native';

import { restoreSession, snapshotSession } from '@/lib/auth-client';
import { recheckSession } from '@/lib/auth-failure-breaker';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { hasTestAccountToken, signInWithDevice } from '@/lib/device-auth';
import logger from '@/lib/logger';
import { holdAccountSwitch } from '@/lib/security/identity-gate';
import { usePinStore } from '@/lib/stores/pin-store';

/** Survives a kill, so a phone that can never resume spends one attestation per window, not per launch. */
export const SESSION_RESUME_AT_KEY = 'session_resume_at';
const SESSION_RESUME_COOLDOWN_MS = 60 * 60_000;

let inFlight: Promise<boolean> | null = null;

/** Resolves once the app is in the foreground. iOS can launch the app in the background. */
export function whenForeground(): Promise<void> {
    if (AppState.currentState !== 'background') return Promise.resolve();
    return new Promise((resolve) => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'background') return;
            sub.remove();
            resolve();
        });
    });
}

/**
 * The device key is the identity, so a dead session can usually come back with
 * nothing asked of the reader. One resume-only device sign-in, for the two
 * places a dead verdict meets a reader (the launch gate, ReauthOnReturn), before
 * the sign-in gate. True means the server confirmed the session alive, which has
 * already closed the breaker and cleared needs_reauth; local data was never touched.
 *
 * Never Forgot PIN, which goes to /login without passing here: device sign-in
 * proves only possession of the phone. No consent is recorded (the reader tapped
 * nothing) and none is owed: resume never stamps it.
 */
export function resumeDeadSession(): Promise<boolean> {
    inFlight ??= attemptResume()
        .catch((error) => {
            logger.warn('[session-resume] failed', { errorName: error instanceof Error ? error.name : typeof error });
            return false;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

async function attemptResume(): Promise<boolean> {
    // A test account's route takes no resume flag and mints by handle.
    if (AppState.currentState === 'background' || usePinStore.getState().locked || hasTestAccountToken()) return false;
    const [cachedUserId, lastAttempt] = await Promise.all([
        getSetting('cached_user_id'),
        getSetting(SESSION_RESUME_AT_KEY),
    ]);
    if (!cachedUserId) return false;
    if (Date.now() - Number(lastAttempt) < SESSION_RESUME_COOLDOWN_MS) return false;
    // A dead verdict can be wrong (an edge's 401), and the sign-in overwrites the jar,
    // so the reader's session is kept to put back. Unreadable: no attempt at all.
    const jar = await snapshotSession();
    // Before the attempt, so a resume that dies or never holds still spends it.
    await setSetting(SESSION_RESUME_AT_KEY, String(Date.now()));

    const result = await signInWithDevice({ resumeOnly: true });

    // The key opened another account, or a server older than the flag minted one
    // and bound this key to it. Held at once, before the identity gates can read
    // its session as an account switch and wipe this reader's data. The gate's
    // sign-in then asks, as it does for any switch.
    const foreign = result.status === 'success' && (result.minted || result.userId !== cachedUserId);
    if (foreign) holdAccountSwitch(result.userId);
    if (result.status !== 'success' || foreign) {
        await restoreSession(jar);
        return false;
    }

    const outcome = await recheckSession();
    // Not on inconclusive: a fresh cookie for this very account is worth keeping.
    if (outcome === 'dead') await restoreSession(jar);
    return outcome === 'alive';
}
