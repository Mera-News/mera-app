import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { useUserStore } from '@/lib/stores/user-store';
import { clearIdentityFault, recordAuthenticatedUser } from '@/lib/security/identity-gate';
import { signInWithEmailCode } from './email-code-sign-in';
import { silentlyAcceptLegal } from './legal-consent';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

interface Props {
    otp?: string;
    email?: string;
    type?: string;
}

export function useDeepLinkVerify({ otp, email, type }: Props) {
    const hasAttempted = useRef(false);

    useEffect(() => {
        if (hasAttempted.current) return;
        hasAttempted.current = true;

        if (!otp || !email) {
            router.replace('/login');
            return;
        }

        (async () => {
            try {
                // The same refusal the sign-in gate uses (invariant 19): a link for another
                // account than this device holds is refused, not signed in and wiped.
                const expected = await getSetting('cached_user_id').catch(() => null);
                const result = await signInWithEmailCode(email, otp, expected);
                if (result.kind !== 'ok') {
                    logger.warn('[DeepLinkVerify] OTP sign-in failed', { kind: result.kind });
                    router.replace('/login');
                } else {
                    // Mirrors OTPVerificationView: record the account before navigating
                    // (identity-gate.ts says why it is module state and not a route param),
                    // resolve any pending re-auth prompt and identity fault, and stamp the
                    // current legal versions silently (email users accepted at sign-up).
                    recordAuthenticatedUser(result.userId);
                    setSetting('cached_user_email', email).catch(() => {});
                    useUserStore.getState().setNeedsReauth(false);
                    clearIdentityFault().catch(() => {});
                    void silentlyAcceptLegal(result.userId);
                    // Through the launch gate, which stamps, checks the account and routes on.
                    router.replace('/logged-in');
                }
            } catch (err: any) {
                logger.captureException(err, { tags: { feature: 'otp', method: 'deep-link-verify' } });
                router.replace('/login');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}

export type { Props as DeepLinkVerifyProps };
