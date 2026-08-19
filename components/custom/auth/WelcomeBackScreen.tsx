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
 * A11y per F2: wrappers are accessible={false}; the buttons carry their own
 * role and label.
 */
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSupportId } from '@/lib/support-id';
import { MaterialIcons } from '@expo/vector-icons';

const WelcomeBackScreen: React.FC = () => {
    const { t } = useTranslation();
    const [supportId, setSupportId] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;
        getSupportId().then((id) => {
            if (!cancelled) setSupportId(id);
        });
        return () => {
            cancelled = true;
            if (copyTimer.current) clearTimeout(copyTimer.current);
        };
    }, []);

    // Same copy affordance as the Settings Support ID row: exact string,
    // transient "Copied" state, no toast (the label change IS the feedback).
    const handleCopy = async () => {
        if (!supportId) return;
        try {
            await Clipboard.setStringAsync(supportId);
        } catch {
            // Clipboard unavailable — no feedback state, nothing to undo.
            return;
        }
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1800);
    };

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
                            {/* The one thing worth keeping from this screen: the
                                account's handle for support. A bordered pill so it
                                reads as a THING to save, not a sentence to skim,
                                with the copy affordance right on it. */}
                            <HStack
                                accessible={false}
                                space="md"
                                className="items-center border border-gray-700 rounded-full px-5 py-2.5"
                            >
                                <Text
                                    size="md"
                                    className="text-white font-semibold"
                                    testID="welcome-back-support-id"
                                >
                                    {t('support.supportId', { id: supportId })}
                                </Text>
                                <Pressable
                                    testID="welcome-back-copy-support-id"
                                    onPress={handleCopy}
                                    hitSlop={8}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={
                                        copied ? t('support.copied') : t('support.copySupportId')
                                    }
                                >
                                    {copied ? (
                                        <Text size="sm" className="text-primary-400">
                                            {t('support.copied')}
                                        </Text>
                                    ) : (
                                        <MaterialIcons name="content-copy" size={18} color="#9ca3af" />
                                    )}
                                </Pressable>
                            </HStack>
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
