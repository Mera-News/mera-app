import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { authClient } from '@/lib/auth-client';
import { setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { recordAuthenticatedUser } from '@/lib/security/identity-gate';
import { silentlyAcceptLegal } from './legal-consent';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
    otp?: string;
    email?: string;
    type?: string;
}

export default function DeepLinkVerifyScreen({ otp, email, type }: Props) {
    const { t } = useTranslation();
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
                const { data, error } = await authClient.signIn.emailOtp({ email, otp });
                if (error || !data?.user) {
                    logger.warn('[DeepLinkVerify] OTP sign-in failed', { error: error?.message });
                    router.replace('/login');
                } else {
                    // The THIRD doorway, and it carries the identical race:
                    // this replaces straight to /logged-in/onboarding, whose
                    // gate runs long before better-auth's session atom settles.
                    // Instrumented here as well as in OTPVerificationView
                    // because this route never touches app/logged-in/index.tsx,
                    // so a recording made only there would never be read on
                    // this path. See identity-gate.ts for why it is module
                    // state and not a route param.
                    recordAuthenticatedUser(data.user.id);
                    setSetting('cached_user_email', email).catch(() => {});
                    // Email users accepted the terms at their original
                    // sign-up — stamp the current versions silently so the
                    // consent surfaces never prompt them. Mirrored from
                    // AuthScreen.handleVerificationSuccess because this route
                    // bypasses AuthScreen entirely.
                    void silentlyAcceptLegal(data.user.id);
                    router.replace('/logged-in/onboarding');
                }
            } catch (err: any) {
                logger.captureException(err, { tags: { feature: 'otp', method: 'deep-link-verify' } });
                router.replace('/login');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        // No opaque fill: the AbstractGradientBackdrop below is the page background.
        <Box className="flex-1 items-center justify-center">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            <Box className="items-center mb-8">
                <MeraLogo size={120} />
            </Box>
            <Spinner size="large" color="white" />
            <Text size="md" className="text-typography-500 mt-4">{t('auth.signingYouIn')}</Text>
        </Box>
    );
}
