import { MaterialIcons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Keyboard, Modal, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import Carousel from 'react-native-reanimated-carousel';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { SUPPORTED_LANGUAGES, translateText } from '@/lib/translation-service';

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
    const setAppLanguage = useAppLanguageStore((s) => s.setAppLanguage);
    const [showPicker, setShowPicker] = useState(false);
    const [packMissing, setPackMissing] = useState(false);

    const selectedLanguage = SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage);

    const handleOpenPicker = useCallback(() => {
        Keyboard.dismiss();
        setShowPicker(true);
    }, []);

    // Probe pack availability. On iOS this surfaces the system sheet asking
    // the user to download the en->target pack; on Android MLKit downloads
    // the en->target model in the background. A null result means the pack
    // isn't usable (user declined, no network, unsupported language).
    const probePack = useCallback((code: string) => {
        if (code === 'en') {
            setPackMissing(false);
            return;
        }
        translateText('Hello', code).then((result) => {
            setPackMissing(result === null);
        });
    }, []);

    const handleRetry = useCallback(() => {
        probePack(appLanguage);
    }, [appLanguage, probePack]);

    const handleSelectLanguage = useCallback(
        async (code: string) => {
            setShowPicker(false);
            const wasRTL = RTL_CODES.has(appLanguage);
            const willBeRTL = RTL_CODES.has(code);
            await setAppLanguage(code);
            probePack(code);
            if (wasRTL !== willBeRTL) {
                Alert.alert(
                    t('language.restartRequired'),
                    t('language.restartDescription'),
                    [
                        { text: t('language.later'), style: 'cancel' },
                        {
                            text: t('language.restart'),
                            onPress: () => Updates.reloadAsync(),
                        },
                    ],
                );
            }
        },
        [appLanguage, setAppLanguage, t, probePack],
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
                <Pressable onPress={handleOpenPicker} style={styles.selectorButton}>
                    <HStack className="items-center" space="xs">
                        <Text className="text-white text-lg">
                            {selectedLanguage?.native ?? 'English'}
                        </Text>
                        <MaterialIcons name="expand-more" size={22} color="rgb(237, 167, 126)" />
                    </HStack>
                </Pressable>
            </HStack>

            {packMissing && (
                <Box className="mx-5 mt-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800/50">
                    <HStack space="sm" className="items-start">
                        <MaterialIcons
                            name="error-outline"
                            size={18}
                            color="#fca5a5"
                            style={{ marginTop: 2 }}
                        />
                        <VStack space="xs" className="flex-1">
                            <Text className="text-red-300 text-sm">
                                {t('language.packMissingBanner')}
                            </Text>
                            {Platform.OS === 'ios' && (
                                <Text className="text-red-200 text-sm">
                                    {t('language.packMissingIosPath')}
                                </Text>
                            )}
                            <Pressable
                                onPress={handleRetry}
                                className="self-start mt-1 px-3 py-1.5 rounded-md bg-red-800/50 border border-red-700"
                            >
                                <Text className="text-red-100 text-sm font-semibold">
                                    {t('language.retry')}
                                </Text>
                            </Pressable>
                        </VStack>
                    </HStack>
                </Box>
            )}

            {/* Language Picker Modal */}
            <Modal
                visible={showPicker}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setShowPicker(false)}
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
