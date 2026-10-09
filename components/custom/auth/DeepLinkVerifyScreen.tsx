import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useTranslation } from 'react-i18next';
import { useDeepLinkVerify, type DeepLinkVerifyProps } from './useDeepLinkVerify';

export default function DeepLinkVerifyScreen({ otp, email, type }: DeepLinkVerifyProps) {
    const { t } = useTranslation();
    useDeepLinkVerify({ otp, email, type });

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
