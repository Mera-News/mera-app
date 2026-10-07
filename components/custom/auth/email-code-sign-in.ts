// The email code sign-in, with the reauth refusal.
//
// On the sign-in gate the account is already known (`cached_user_id`). A code
// that signs in a DIFFERENT account must never reach the identity gate: that
// gate reads a different id as an account switch and wipes this device's data.
// So a mismatch signs the new session out again and keeps everything local:
// the old stamps, the data, the account.
//
// Two guards, either one enough:
//  - the server (mera-server 7c9adbc4, not deployed everywhere yet): given
//    `expectedUserId`, it answers 409 REAUTH_ACCOUNT_MISMATCH and creates
//    nothing;
//  - this client: the signed-in id is compared with the expected one. This is
//    the primary guard and works against a server without the check.

import Constants from 'expo-constants';

import { authClient } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { holdAccountSwitch, releaseAccountSwitch } from '@/lib/security/identity-gate';
import { secureStore } from '@/lib/utils/secure-store-adapter';

const APP_SLUG = Constants.expoConfig?.slug || 'app';
/** The better-auth session as stored on the device (lib/security/local-wipe.ts). */
const SESSION_KEYS = [`${APP_SLUG}_cookie`, `${APP_SLUG}_session_data`];

export type EmailCodeSignIn =
    | { kind: 'ok'; userId: string }
    | { kind: 'mismatch' }
    | { kind: 'wrong' };

type SignInResponse = {
    data?: { user?: { id?: string } | null } | null;
    error?: { status?: number; code?: string; message?: string } | null;
};
type SignInFn = (body: { email: string; otp: string; expectedUserId?: string }) => Promise<SignInResponse>;

/** A Mongo ObjectId, the only shape the server accepts for `expectedUserId`. */
const USER_ID = /^[0-9a-f]{24}$/;

const defaultSignIn: SignInFn = (body) =>
    authClient.signIn.emailOtp(body as { email: string; otp: string }) as Promise<SignInResponse>;

const defaultSignOut = async (): Promise<void> => {
    await authClient.signOut();
};

/**
 * Sign in with an emailed code. `expectedUserId` is set only on the sign-in
 * gate (the account this device already holds); a first sign-in passes none.
 */
export async function signInWithEmailCode(
    email: string,
    otp: string,
    expectedUserId?: string | null,
    deps: { signIn?: SignInFn; signOut?: () => Promise<void> } = {},
): Promise<EmailCodeSignIn> {
    const signIn = deps.signIn ?? defaultSignIn;
    const signOut = deps.signOut ?? defaultSignOut;
    const expected = expectedUserId && USER_ID.test(expectedUserId) ? expectedUserId : undefined;

    let res = await signIn(expected ? { email, otp, expectedUserId: expected } : { email, otp });
    // A server that validates its body strictly and does not know the field
    // yet: once more without it (validation runs before the code is checked,
    // so the code is not spent). Never on a wrong-code 400.
    if (expected && res.error?.status === 400 && res.error.code === 'VALIDATION_ERROR') {
        res = await signIn({ email, otp });
    }

    if (res.error) {
        if (expected && (res.error.status === 409 || res.error.code === 'REAUTH_ACCOUNT_MISMATCH')) {
            return { kind: 'mismatch' };
        }
        return { kind: 'wrong' };
    }

    const userId = res.data?.user?.id;
    if (!userId) return { kind: 'wrong' };

    if (expectedUserId && userId !== expectedUserId) {
        await signOutWrongAccount(userId, signOut);
        return { kind: 'mismatch' };
    }
    // A right account: any hold left by an earlier refusal goes.
    releaseAccountSwitch();
    return { kind: 'ok', userId };
}

/**
 * Sign the wrong account's new session out. Held first, synchronously, so the
 * screens that react to the session atom (login's session shortcut, the
 * identity-switch watcher) leave it alone; the hold is what keeps them from
 * routing it into the wiping gate. NOT released here: a session fetch sent
 * before the sign-out can still land that account in the atom afterwards. The
 * next good sign-in releases it.
 */
async function signOutWrongAccount(userId: string, signOut: () => Promise<void>): Promise<void> {
    holdAccountSwitch(userId);
    try {
        await signOut();
    } catch (error) {
        logger.captureException(error, { tags: { feature: 'otp', method: 'signOutWrongAccount' } });
    }
    // Offline or a failed sign-out still must not leave that account's cookie:
    // the next launch would read it as an account switch and wipe.
    for (const key of SESSION_KEYS) {
        await secureStore.deleteItemAsync(key).catch(() => undefined);
    }
}
