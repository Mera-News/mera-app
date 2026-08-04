import React from 'react';
import { ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getNativeLanguageName } from '@/lib/translation-service';

interface LanguageSwitchProgressProps {
    /** Language being switched to. */
    readonly code: string;
    readonly onCancel: () => void;
}

/**
 * What the user looks at while the OS prepares a language.
 *
 * Three things, and all three are load-bearing:
 *
 *  - a spinner, so the wait reads as work rather than as a frozen screen;
 *  - copy that ASKS them to stay, and says plainly what leaving costs, because
 *    walking away mid-download is what produces the degraded experience;
 *  - a cancel button, because a nudge to stay with no visible way out is a
 *    trap wearing a friendlier label — and being trapped by this exact feature
 *    is the bug this whole change exists to fix.
 *
 * The button is the ONLY exit while this is on screen (back is locked), which
 * makes it load-bearing: it must respond the instant it renders and must never
 * wait on the native call, since that call is precisely the thing that can
 * hang. `onCancel` is synchronous by contract.
 */
const LanguageSwitchProgress: React.FC<LanguageSwitchProgressProps> = ({ code, onCancel }) => {
    const { t } = useTranslation();
    const language = getNativeLanguageName(code) ?? code;

    return (
        <Box
            testID="language-switch-progress"
            className="mt-2 p-4 bg-gray-800 rounded-lg border border-gray-700"
        >
            <VStack space="sm">
                <HStack space="md" className="items-center">
                    <ActivityIndicator size="small" color="#a78bfa" />
                    <Text className="text-white text-base font-medium flex-1">
                        {t('language.switchingTitle', { language })}
                    </Text>
                </HStack>
                <Text className="text-typography-400 text-sm leading-5">
                    {t('language.switchingNudge', { language })}
                </Text>
                <Pressable
                    testID="language-switch-cancel"
                    onPress={onCancel}
                    className="flex-row items-center justify-center mt-1 py-3 px-4 bg-gray-700 rounded-lg"
                >
                    <Text className="text-white text-sm font-medium">
                        {t('language.switchingCancel')}
                    </Text>
                </Pressable>
            </VStack>
        </Box>
    );
};

export default LanguageSwitchProgress;
