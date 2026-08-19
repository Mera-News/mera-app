/**
 * S10 welcome-back screen: a fresh-looking install signed in and the server
 * said the trial is already consumed (`welcomeBack` on the device sign-in
 * result — no stored credentials at attempt time AND trialAvailable false).
 *
 * Reached ONLY from AuthScreen's device sign-in success handler, never
 * mid-session: the gate lives on the sign-in result, not in this screen.
 * Continue lands on /logged-in, whose gates route an unentitled account to
 * the paywall / free tier as usual — this screen only explains WHY there is
 * no fresh trial and hands over the Support ID.
 *
 * A11y per F2: wrappers are accessible={false}; the button carries its own
 * role and label.
 */
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSupportId } from '@/lib/support-id';

const WelcomeBackScreen: React.FC = () => {
    const { t } = useTranslation();
    const [supportId, setSupportId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getSupportId().then((id) => {
            if (!cancelled) setSupportId(id);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleContinue = () => {
        router.replace('/logged-in');
    };

    return (
        <Box testID="welcome-back-root" accessible={false} className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            <Box accessible={false} className="flex-1 justify-center px-6">
                <VStack accessible={false} space="lg" className="items-center">
                    <MeraLogo size={96} />
                    <Text size="2xl" className="text-white font-semibold text-center">
                        {t('welcomeBack.title')}
                    </Text>
                    <Text size="md" className="text-gray-300 text-center">
                        {t('welcomeBack.body')}
                    </Text>

                    {supportId && (
                        <VStack accessible={false} space="xs" className="items-center mt-2">
                            <Text
                                size="sm"
                                className="text-gray-400"
                                testID="welcome-back-support-id"
                            >
                                {t('support.supportId', { id: supportId })}
                            </Text>
                            <Text size="xs" className="text-gray-500 text-center">
                                {t('support.saveHint')}
                            </Text>
                        </VStack>
                    )}

                    <Pressable
                        testID="welcome-back-continue"
                        onPress={handleContinue}
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={t('welcomeBack.continue')}
                        className="h-14 rounded-full items-center justify-center bg-primary-500 self-stretch mt-4"
                    >
                        <Text className="text-black text-base font-semibold">
                            {t('welcomeBack.continue')}
                        </Text>
                    </Pressable>
                </VStack>
            </Box>
        </Box>
    );
};

export default WelcomeBackScreen;
