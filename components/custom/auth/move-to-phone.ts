// The move to phone sign-in, for accounts that signed in with email before
// email sign-in closed: sign in with this phone, move the account to it, and
// delete the email server side. Every email still on an account is deleted on
// EMAIL_CUTOFF.
//
// This file is the flow and the tiny registry the inbox action, the Settings
// row and the host share. The UI is MoveToPhoneHost (mounted once in the
// logged-in layout): the confirm dialog, then the four-step progress.
//
// Import-light on purpose (the inbox actions and the feedback auto-show host
// import it): the device sign-in client, the settings table, the user store
// and the auth client are required lazily, at the call.

import { holdRestart } from '@/lib/app-restart';
import logger from '@/lib/logger';

/** The day every remaining email is deleted (owner). */
export const EMAIL_CUTOFF = '2026-10-30';

/** "30 October" in the app's language. Noon UTC so no time zone moves the day. */
export function emailCutoffLabel(language?: string): string {
    const [y, m, d] = EMAIL_CUTOFF.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12));
    try {
        return date.toLocaleDateString(language, { day: 'numeric', month: 'long' });
    } catch {
        return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    }
}

/** True from local midnight on EMAIL_CUTOFF, by the device clock: email
 *  sign-in stops being offered (the gate shows the "ended" screen instead). */
export function emailSignInEnded(now: number = Date.now()): boolean {
    const [y, m, d] = EMAIL_CUTOFF.split('-').map(Number);
    return now >= new Date(y, m - 1, d).getTime();
}

/** The four progress steps, in order. Linking and removing both advance across
 *  the one `/device/convert` call. */
export type MoveStep = 'checking' | 'linking' | 'removing' | 'done';

export type MoveOutcome =
    | { kind: 'moved' }
    /** This phone can't sign in without email (no attestation, no dev bypass). */
    | { kind: 'unsupported' }
    /** Nothing changed; offer a retry. `step` is the one that failed. */
    | { kind: 'failed'; step: MoveStep };

/**
 * Run the move. Never throws. On success the account is the same user id, so
 * nothing local is wiped: only the email this device remembers is forgotten,
 * and the session atom is refreshed so Settings reads the placeholder address
 * (the session is Settings' fallback once the stored email is gone, and a stale
 * atom would keep showing the old address there).
 */
export async function moveToPhone(onStep: (step: MoveStep) => void): Promise<MoveOutcome> {
    // Not an excursion, so a finally is right: nothing here sends the user out,
    // and a restart mid-call would only throw the progress away.
    const release = holdRestart('move-to-phone');
    try {
        const { convertWithDevice } = require('@/lib/device-auth') as typeof import('@/lib/device-auth');
        const result = await convertWithDevice(onStep);
        if (result.status === 'unsupported') return { kind: 'unsupported' };
        if (result.status === 'failed') return { kind: 'failed', step: result.step };
        onStep('removing');
        await forgetLocalEmail();
        // Owner: the store plan follows the account after a move (RevenueCat
        // is already identified as this signed-in user, so it runs now).
        requestStoreSyncForCurrentUser();
        onStep('done');
        return { kind: 'moved' };
    } catch (error) {
        logger.captureException(error, { tags: { component: 'move-to-phone' } });
        return { kind: 'failed', step: 'checking' };
    } finally {
        release();
    }
}

/** Server side the move is done; a failed local step only means the next
 *  launch offers the move again and the server answers already-converted. */
async function forgetLocalEmail(): Promise<void> {
    try {
        const { deleteSetting } =
            require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
        await deleteSetting('cached_user_email');
    } catch (error) {
        logger.warn('[move-to-phone] could not delete the cached email row', { error: String(error) });
    }
    try {
        const { useUserStore } = require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
        useUserStore.setState({ userEmail: null });
    } catch {
        // Store unavailable: the row is gone, so the next hydrate agrees.
    }
    try {
        const { authClient } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
        // Server truth, not the cached cookie; then poke the atom so mounted
        // useSession readers refetch.
        await authClient.getSession({ query: { disableCookieCache: true } }).catch(() => undefined);
        authClient.$store.notify('$sessionSignal');
    } catch {
        // Best effort: the atom heals on its next refetch.
    }
}

function requestStoreSyncForCurrentUser(): void {
    try {
        const { useUserStore } = require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
        const userId = useUserStore.getState().userId;
        if (userId) (require('@/lib/revenuecat') as typeof import('@/lib/revenuecat')).requestStorePurchasesSync(userId);
    } catch {
        // Restore purchases in Settings is the manual path.
    }
}

/**
 * Whether this account signed in with email: the email row this device keeps,
 * or (installs from before that row existed) a real address on the session.
 * Pure phone accounts answer false. Never throws; unsure reads false.
 */
export async function isEmailAccount(): Promise<boolean> {
    try {
        const { getSetting } =
            require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
        const { emailLooksAnonymous } =
            require('@/lib/subscription/email-capture') as typeof import('@/lib/subscription/email-capture');
        const stored = await getSetting('cached_user_email');
        if (stored && !emailLooksAnonymous(stored)) return true;
        const { authClient } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
        const session = await authClient.getSession();
        const email = session?.data?.user?.email;
        return !!email && !emailLooksAnonymous(email);
    } catch {
        return false;
    }
}

// ─── The silent bind ─────────────────────────────────────────────────────────
// Once per device and account, at launch: bind this phone to a signed-in email
// account WITHOUT moving it, so someone who never opens the move still signs in
// with this phone after every email is deleted on EMAIL_CUTOFF. A pure phone
// account is skipped: it signed in with this phone's own key, so it is bound by
// construction, and skipping it spares an attestation call per install.
// Background only: no UI, never blocks, never signs anyone out; a failure or an
// unsupported phone simply tries again next launch.

export const DEVICE_BOUND_SETTING_KEY = 'device_bound_user';

let bindInFlight: Promise<void> | null = null;

export function bindPhoneOnce(userId: string): Promise<void> {
    if (!userId) return Promise.resolve();
    if (bindInFlight) return bindInFlight;
    bindInFlight = (async () => {
        try {
            const { getSetting, setSetting } =
                require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
            if ((await getSetting(DEVICE_BOUND_SETTING_KEY)) === userId) return;
            if (!(await isEmailAccount())) return;
            const { convertWithDevice } = require('@/lib/device-auth') as typeof import('@/lib/device-auth');
            const result = await convertWithDevice(undefined, { bindOnly: true });
            if (result.status === 'unsupported' || result.status === 'failed') return;
            await setSetting(DEVICE_BOUND_SETTING_KEY, userId);
        } catch (error) {
            logger.warn('[move-to-phone] silent bind failed', { error: String(error) });
        } finally {
            bindInFlight = null;
        }
    })();
    return bindInFlight;
}

// ─── Who opens it ────────────────────────────────────────────────────────────
// The inbox row's action and the Settings row ask; the one mounted host shows
// it. Same shape as a store subscription, without a store for one event.

type MoveListener = () => void;
const listeners = new Set<MoveListener>();

export function requestMoveToPhone(): void {
    for (const listener of listeners) {
        try {
            listener();
        } catch {
            // One broken listener must not stop the rest.
        }
    }
}

export function subscribeMoveToPhone(listener: MoveListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

let visible = false;

/** The host reports its own visibility, so the feedback auto-show host never
 *  stacks a question over the move. */
export function setMoveToPhoneVisible(next: boolean): void {
    visible = next;
}

export function isMoveToPhoneVisible(): boolean {
    return visible;
}

/** Test seam. */
export function __resetMoveToPhoneForTests(): void {
    listeners.clear();
    visible = false;
    bindInFlight = null;
}
