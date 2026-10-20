// The dev-only test-account deep link, and the one sign-in path Observability's
// test-account controls share with it.
//
//   meraapp:///dev-test-account?handle=resident-ios[&reset=1]
//   meraapp:///dev-test-account?new=1
//
// A release build, or a dev build without EXPO_PUBLIC_TEST_ACCOUNT_TOKEN, goes
// to '/' and touches nothing. The link names a HANDLE, never a user id: the
// server resolves the handle inside its test namespace and nothing else.
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { finishAccountDeletion } from '@/components/custom/config-mera/use-delete-account';
import {
    TEST_ACCOUNT_HANDLE_PATTERN,
    TEST_ACCOUNT_HANDLE_STORE_KEY,
    deleteTestAccount,
    hasTestAccountToken,
    listTestAccounts,
    setTestAccountHandle,
    signInWithDevice,
} from '@/lib/device-auth';
import logger from '@/lib/logger';
import { isAuthReadQuarantineActive } from '@/lib/security/install-boundary-latch';
import { secureStore } from '@/lib/utils/secure-store-adapter';

import { completeDeviceSignIn } from './useAuthScreen';

export interface DevTestAccountLinkParams {
    handle?: string;
    new?: string;
    reset?: string;
}

export type TestAccountSignIn = { ok: true; userId: string } | { ok: false; why: string };

/** A fresh throwaway handle. */
export function newThrowawayHandle(): string {
    return `tmp-${Crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** The install boundary (run by the app root on a cold deep link) deletes
 *  the session cookie on a fresh install. Signing in before it decided would
 *  lose the new cookie, so wait for its release, bounded. */
async function waitForInstallBoundary(): Promise<void> {
    for (let i = 0; i < 100 && isAuthReadQuarantineActive(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/**
 * Sign this device in to the test account `handle`: optionally delete it
 * first (a fresh account under the same handle), point the slot at it, sign
 * in, then the same bookkeeping as Sign in with this phone. The CALLER routes
 * to '/logged-in' on success, so the identity gate and the cross-user wipe run.
 */
export async function signInToTestAccount(handle: string, { reset = false } = {}): Promise<TestAccountSignIn> {
    if (!__DEV__ || !hasTestAccountToken()) return { ok: false, why: 'no-token' };
    if (!TEST_ACCOUNT_HANDLE_PATTERN.test(handle)) return { ok: false, why: 'invalid-handle' };
    await waitForInstallBoundary();
    if (reset && (await deleteTestAccount(handle)) === 'failed') return { ok: false, why: 'reset-failed' };
    // The slot names the account this device is ON, so a failed switch puts it back.
    const previous = await secureStore.getItemAsync(TEST_ACCOUNT_HANDLE_STORE_KEY).catch(() => null);
    await setTestAccountHandle(handle);
    const result = await signInWithDevice();
    if (result.status !== 'success') {
        await setTestAccountHandle(previous && TEST_ACCOUNT_HANDLE_PATTERN.test(previous) ? previous : null);
        return { ok: false, why: result.status === 'failed' ? result.reason : result.status };
    }
    await completeDeviceSignIn(result);
    return { ok: true, userId: result.userId };
}

/**
 * Delete the test account `handle` now. Signs out and severs this device only
 * when the server says that handle IS the signed-in account: the handle in the
 * slot (or the tmp- fallback) can name another account, for example in a dev
 * build signed in with OTP. An unknown owner (the list failed) counts as not
 * this account. Never signs out on a delete that did not happen: a 404 for the
 * signed-in handle means a wrong or disabled token, and the account is alive.
 */
export async function removeTestAccount(
    handle: string,
    signedInUserId: string | null,
): Promise<'signed-out' | 'deleted' | 'not-found' | 'failed'> {
    const owner = (await listTestAccounts())?.find((a) => a.handle === handle)?.userId ?? null;
    const result = await deleteTestAccount(handle);
    if (result !== 'deleted') return result;
    if (!owner || owner !== signedInUserId) return 'deleted';
    await finishAccountDeletion();
    return 'signed-out';
}

/** Where the link goes, after doing its work. */
export async function runDevTestAccountLink(params: DevTestAccountLinkParams): Promise<'/' | '/logged-in'> {
    if (!__DEV__ || !hasTestAccountToken()) return '/';
    const handle = params.new === '1' ? newThrowawayHandle() : params.handle;
    if (!handle) return '/';
    const outcome = await signInToTestAccount(handle, { reset: params.reset === '1' });
    if (!outcome.ok) {
        logger.warn('[dev-test-account] sign-in failed', { why: outcome.why });
        return '/';
    }
    return '/logged-in';
}

export function useDevTestAccountLink(params: DevTestAccountLinkParams): void {
    const started = useRef(false);
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void runDevTestAccountLink(params)
            .catch((error) => {
                logger.warn('[dev-test-account] link threw', {
                    errorName: error instanceof Error ? error.name : typeof error,
                });
                return '/' as const;
            })
            .then((to) => router.replace(to));
        // Runs once per mount: the link's params are read on arrival.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
