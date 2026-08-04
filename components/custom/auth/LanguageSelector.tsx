import { MaterialIcons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Keyboard, Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import Carousel from 'react-native-reanimated-carousel';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useLanguageSwitch, LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import LanguageSwitchProgress from '@/components/custom/config-mera/LanguageSwitchProgress';
import LanguageDownloadHint from '@/components/custom/config-mera/LanguageDownloadHint';
import { getLanguageName, SUPPORTED_LANGUAGES } from '@/lib/translation-service';

const RTL_CODES = new Set(['ar', 'he']);

const LANGUAGE_WORDS = [
    'Language',
    'لغة',
    'Taal',
    'Langue',
    'Sprache',
    'भाषा',
    'Bahasa',
    'Lingua',
    '言語',
    '언어',
    '语言',
    '語言',
    'Język',
    'Idioma',
    'Язык',
    'ภาษา',
    'Dil',
    'Мова',
    'Ngôn ngữ',
];

const TICKER_HEIGHT = 110;
const TICKER_ITEM_HEIGHT = 36;
const TICKER_WIDTH = 120;
const SLIDE_DURATION_MS = 700;
const AUTOPLAY_INTERVAL_MS = 1400;

const renderTickerItem = ({ item }: { item: string }) => (
    <View style={styles.tickerItem}>
        <Text style={styles.tickerText}>{item}</Text>
    </View>
);

const LanguageSelector: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const [showPicker, setShowPicker] = useState(false);

    const selectedLanguage = SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage);

    const handleOpenPicker = useCallback(() => {
        Keyboard.dismiss();
        setShowPicker(true);
    }, []);

    // Only fires on a language that was actually applied.
    const handleCommitted = useCallback(
        (code: string, previousCode: string) => {
            if (RTL_CODES.has(previousCode) === RTL_CODES.has(code)) return;
            Alert.alert(
                t('language.restartRequired'),
                t('language.restartDescription'),
                [
                    { text: t('language.later'), style: 'cancel' },
                    { text: t('language.restart'), onPress: () => Updates.reloadAsync() },
                ],
            );
        },
        [t],
    );

    const handleResult = useCallback(
        ({ code, outcome, fellBackToEnglish }: LanguageSwitchResult) => {
            // ENGLISH names, not endonyms — see the same note on the Settings
            // picker. These are words inside a sentence explaining that the
            // switch did not happen; the endonym put RTL script mid-LTR
            // sentence and named the language in a script the reader may not
            // read. The spinner TITLE keeps the endonym, where it is a label
            // rather than prose.
            const language = getLanguageName(code) ?? code;
            const current = getLanguageName(
                useAppLanguageStore.getState().appLanguage,
            ) ?? 'English';
            // Read AFTER the hook applied it, so `current` is already English
            // here — the body names the landing spot rather than re-deriving it.
            if (fellBackToEnglish) {
                Alert.alert(
                    t('language.switchFailedTitle', { language }),
                    t('language.switchDeviceUnsupportedBody', { language }),
                );
                return;
            }
            const body = outcome === 'timeout'
                ? t('language.switchTimedOutBody', { language, previous: current })
                : outcome === 'language-unsupported'
                    ? t('language.switchUnsupportedBody', { language, previous: current })
                    : t('language.switchFailedBody', { language, previous: current });
            Alert.alert(t('language.switchFailedTitle', { language }), body);
        },
        [t],
    );

    // Identical machine to the Settings picker, deliberately shared rather
    // than copied — the copy that used to live here is what let the two drift
    // into the same native crash. See lib/hooks/use-language-switch.ts.
    const {
        pendingCode,
        busy,
        requestSwitch,
        notifyPickerDismissed,
        cancel,
    } = useLanguageSwitch({ onCommitted: handleCommitted, onResult: handleResult });

    const handleSelectLanguage = useCallback(
        (code: string) => {
            requestSwitch(code);
            setShowPicker(false);
        },
        [requestSwitch],
    );

    return (
        <>
            <HStack className="items-center justify-center mt-6" space="lg">
                <View style={styles.tickerContainer} pointerEvents="none">
                    <Carousel
                        vertical
                        loop
                        autoPlay
                        autoPlayInterval={AUTOPLAY_INTERVAL_MS}
                        scrollAnimationDuration={SLIDE_DURATION_MS}
                        width={TICKER_WIDTH}
                        height={TICKER_HEIGHT}
                        mode="parallax"
                        modeConfig={{
                            parallaxScrollingScale: 1,
                            parallaxAdjacentItemScale: 0.7,
                            parallaxScrollingOffset: TICKER_ITEM_HEIGHT,
                        }}
                        data={LANGUAGE_WORDS}
                        renderItem={renderTickerItem}
                    />
                </View>

                {/* Language selector with glow */}
                <Pressable
                    testID="auth-language-selector"
                    onPress={handleOpenPicker}
                    disabled={busy}
                    style={[styles.selectorButton, busy ? styles.selectorButtonDisabled : null]}
                >
                    <HStack className="items-center" space="xs">
                        <Text className="text-white text-lg">
                            {selectedLanguage?.native ?? 'English'}
                        </Text>
                        <MaterialIcons name="expand-more" size={22} color="rgb(237, 167, 126)" />
                    </HStack>
                </Pressable>
            </HStack>

            {/* Below the selector, never beside it — the ticker and the
                selector share one centred row, and prose in that row would
                fight the animation for the reader's eye. Its own margins
                rather than a wrapper View, so that on Android — where the
                component renders nothing, there being no download sheet —
                it leaves no gap behind. The 20pt gutter is the progress
                card's, so the guidance and the card that replaces it line up. */}
            <LanguageDownloadHint
                testID="auth-language-download-hint"
                className="text-center mt-3 mx-5"
            />

            {busy && pendingCode ? (
                <View style={styles.progressWrap}>
                    <LanguageSwitchProgress code={pendingCode} onCancel={cancel} />
                </View>
            ) : null}

            {/* Language Picker Modal */}
            <Modal
                visible={showPicker}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setShowPicker(false)}
                // Probe only once the dismissal transition has finished —
                // presenting Apple's sheet during it is a native crash.
                onDismiss={notifyPickerDismissed}
            >
                <GluestackUIProvider mode="dark">
                    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 16 }}>
                        <HStack className="items-center justify-between px-5 pb-4">
                            <Text className="text-white text-xl font-semibold">
                                {t('language.appLanguage')}
                            </Text>
                            <Pressable onPress={() => setShowPicker(false)}>
                                <MaterialIcons name="close" size={24} color="#ffffff" />
                            </Pressable>
                        </HStack>
                        <FlatList
                            data={SUPPORTED_LANGUAGES}
                            keyExtractor={(item) => item.code}
                            renderItem={({ item }) => {
                                const isSelected = item.code === appLanguage;
                                return (
                                    <TouchableOpacity
                                        onPress={() => handleSelectLanguage(item.code)}
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            paddingVertical: 14,
                                            paddingHorizontal: 20,
                                            borderBottomWidth: 1,
                                            borderBottomColor: '#1f2937',
                                        }}
                                    >
                                        <VStack>
                                            <Text
                                                className={
                                                    isSelected
                                                        ? 'text-violet-400 font-semibold'
                                                        : 'text-white'
                                                }
                                            >
                                                {item.name}
                                            </Text>
                                            <Text className="text-gray-400 text-sm">
                                                {item.native}
                                            </Text>
                                        </VStack>
                                        {isSelected && (
                                            <MaterialIcons
                                                name="check"
                                                size={20}
                                                color="#a78bfa"
                                            />
                                        )}
                                    </TouchableOpacity>
                                );
                            }}
                            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
                        />
                    </Box>
                </GluestackUIProvider>
            </Modal>
        </>
    );
};

const styles = StyleSheet.create({
    tickerContainer: {
        height: TICKER_HEIGHT,
        width: TICKER_WIDTH,
        overflow: 'hidden',
    },
    tickerItem: {
        flex: 1,
        width: TICKER_WIDTH,
        justifyContent: 'center',
        alignItems: 'center',
    },
    tickerText: {
        fontSize: 18,
        color: '#ffffff',
    },
    progressWrap: {
        marginTop: 16,
        marginHorizontal: 20,
    },
    selectorButtonDisabled: {
        opacity: 0.4,
    },
    selectorButton: {
        borderWidth: 1,
        borderColor: 'rgb(237, 167, 126)',
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 8,
        shadowColor: 'rgb(237, 167, 126)',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 12,
    },
});

export default LanguageSelector;
