import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { authClient } from '@/lib/auth-client';
import { setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

interface Props {
    otp?: string;
    email?: string;
    type?: string;
}

export default function DeepLinkVerifyScreen({ otp, email, type }: Props) {
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
                    setSetting('cached_user_email', email).catch(() => {});
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
        <Box className="flex-1 bg-background-0 items-center justify-center">
            <Box className="items-center mb-8">
                <MeraLogo size={120} />
            </Box>
            <Spinner size="large" color="white" />
            <Text size="md" className="text-typography-500 mt-4">Signing you in…</Text>
        </Box>
    );
}
