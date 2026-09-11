import React from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getNativeLanguageName, resolveUiLocale } from '@/lib/translation-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';

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
 *  - on iOS, the one instruction that actually unblocks the wait: tap the
 *    circled down-arrow beside each row in Apple's "Required Downloads" sheet.
 *    Nothing downloads until they do, and the sheet gives no hint of that — so
 *    without this line the spinner just spins forever. It sits directly under
 *    the title BECAUSE Apple's sheet covers roughly the bottom half of the
 *    screen: anything below the nudge is hidden exactly when it is needed.
 *    Android has no such sheet, hence the platform gate;
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

    // The language the user is REALLY still on. The store does not move until
    // the switch commits, so for the whole time this card is on screen it holds
    // the previous language — see `use-language-switch.ts`, which relies on the
    // same invariant to revert. (On the success path the store moves one tick
    // before this card unmounts; that frame is not observable.)
    //
    // `?? 'en'` is unreachable — the store only ever holds a SUPPORTED_LANGUAGES
    // code — but English is this app's documented floor, and it is the one
    // bundle guaranteed to exist.
    const previousLocale = resolveUiLocale(
        useAppLanguageStore((s) => s.appLanguage),
    ) ?? 'en';

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
                {Platform.OS === 'ios' ? (
                    <Text
                        testID="language-switch-download-hint"
                        className="text-typography-300 text-sm font-medium"
                    >
                        {t('language.downloadHintNowPrefix')}{' '}
                        <MaterialCommunityIcons
                            name="arrow-down-circle-outline"
                            size={15}
                            color="#a78bfa"
                        />
                        {' '}{t('language.downloadHintNowSuffix')}
                    </Text>
                ) : null}
                <Text className="text-typography-400 text-sm">
                    {t('language.switchingNudge', { language })}
                </Text>
                <Pressable
                    testID="language-switch-cancel"
                    onPress={onCancel}
                    className="flex-row items-center justify-center mt-1 py-3 px-4 bg-gray-700 rounded-lg"
                >
                    {/* THE ONE STRING ON THIS CARD THAT IS NOT IN THE TARGET
                        LANGUAGE, and it is deliberate. Everything else here
                        describes the language you are moving TO, so it belongs
                        in that language. This button is about the language you
                        are moving FROM — it takes you back there — and it is
                        the only exit while back navigation is locked. Someone
                        who mistapped an unfamiliar language would otherwise
                        find their sole escape written in the very language they
                        cannot read, which turns the nudge into the trap this
                        whole feature exists to remove. Do not "tidy" this into
                        a bare t() call. */}
                    <Text className="text-white text-sm font-medium">
                        {t('language.switchingCancel', { lng: previousLocale })}
                    </Text>
                </Pressable>
            </VStack>
        </Box>
    );
};

export default LanguageSwitchProgress;
