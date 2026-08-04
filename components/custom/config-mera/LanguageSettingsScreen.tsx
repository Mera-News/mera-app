import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getLanguageName, SUPPORTED_LANGUAGES } from '@/lib/translation-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useLanguageSwitch, LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import LanguageSwitchProgress from '@/components/custom/config-mera/LanguageSwitchProgress';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Linking, Modal, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as Updates from 'expo-updates';

interface LanguageSettingsScreenProps {
    onBack?: () => void;
    /** Lets the route lock the stack's swipe-back gesture while a switch runs. */
    onBusyChange?: (busy: boolean) => void;
}

const RTL_CODES = new Set(['ar', 'he']);

const LanguageSettingsScreen: React.FC<LanguageSettingsScreenProps> = ({ onBack, onBusyChange }) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    const appLanguage = useAppLanguageStore((s) => s.appLanguage);

    const [showLangPicker, setShowLangPicker] = useState(false);
    const [showGuideVideo, setShowGuideVideo] = useState(false);

    const handleWatchGuide = () => setShowGuideVideo(true);

    const selectedLanguage = SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage);

    // Only fires on a language that was actually applied, so a failed attempt
    // can never prompt for a restart the user did not ask for.
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

    // Every non-success ending is reported by name, and names the language the
    // user is left on — an attempt that silently does nothing is the thing
    // being fixed here.
    const handleResult = useCallback(
        ({ code, outcome, fellBackToEnglish }: LanguageSwitchResult) => {
            // ENGLISH names here, not endonyms — these strings are prose in the
            // reader's CURRENT language, explaining that the switch did not
            // happen. `getNativeLanguageName` gave "Couldn't switch to العربية",
            // which drops RTL script into the middle of an LTR sentence, and
            // names the language in a script the reader may not read (the exact
            // reasoning ArticleMetaRow already follows). The spinner TITLE keeps
            // the endonym on purpose: there it is a label for what you are
            // getting, not a word inside a sentence.
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

    const {
        pendingCode,
        busy,
        requestSwitch,
        notifyPickerDismissed,
        cancel,
    } = useLanguageSwitch({ onCommitted: handleCommitted, onResult: handleResult });

    React.useEffect(() => {
        onBusyChange?.(busy);
    }, [busy, onBusyChange]);

    // Closing the picker is all that happens here. The probe waits for the
    // modal's `onDismiss` — presenting Apple's sheet on top of a dismissing
    // pageSheet is a native crash. See lib/hooks/use-language-switch.ts.
    const handleSelectLanguage = (code: string) => {
        requestSwitch(code);
        setShowLangPicker(false);
    };

    const handleBack = () => {
        if (busy) return;
        onBack?.();
    };

    return (
        <GluestackUIProvider mode="dark">
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                {/* Floating Back Button */}
                {onBack && (
                    <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                        <Pressable
                            testID="language-back"
                            onPress={handleBack}
                            disabled={busy}
                            // Announced as disabled, not merely dimmed. The a11y
                            // tree reported `enabled: true, hittable: false`
                            // while probing, so VoiceOver offered a button that
                            // silently did nothing — the sighted user sees the
                            // 40% opacity, a screen-reader user got no signal at
                            // all. `accessibilityState` is what carries it;
                            // `disabled` alone does not on a Pressable.
                            accessibilityState={{ disabled: busy }}
                            className={`bg-gray-900 rounded-full p-3 shadow-hard-2 ${busy ? 'opacity-40' : ''}`}
                        >
                            <MaterialIcons
                                name="arrow-back"
                                size={24}
                                color={busy ? '#6b7280' : '#ffffff'}
                            />
                        </Pressable>
                    </Box>
                )}

                {/* Header */}
                <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                    <Text className="text-xl font-semibold text-white text-center">
                        {t('language.title')}
                    </Text>
                </VStack>

                <ScrollView className="flex-1 pt-1">
                    <VStack className="px-5" space="xl">

                        {/* App Language */}
                        <VStack space="md">
                            <HStack space="md" className="items-center">
                                <MaterialIcons name="language" size={24} color="#a78bfa" />
                                <VStack className="flex-1">
                                    <Text className="text-white text-lg font-semibold">
                                        {t('language.appLanguage')}
                                    </Text>
                                    <Text className="text-typography-500 text-sm mt-0.5">
                                        {t('language.appLanguageDescription')}
                                    </Text>
                                </VStack>
                            </HStack>

                            <Pressable
                                testID="language-current-row"
                                onPress={() => setShowLangPicker(true)}
                                disabled={busy}
                                className={`flex-row items-center justify-between py-4 px-4 border border-gray-700 rounded-lg ${busy ? 'opacity-40' : ''}`}
                            >
                                <VStack>
                                    <Text className="text-white text-base font-medium">
                                        {selectedLanguage?.name ?? 'English'}
                                    </Text>
                                    <Text className="text-gray-400 text-sm">
                                        {selectedLanguage?.native ?? 'English'}
                                    </Text>
                                </VStack>
                                <MaterialIcons name="chevron-right" size={20} color="#999999" />
                            </Pressable>

                            {busy && pendingCode ? (
                                <LanguageSwitchProgress code={pendingCode} onCancel={cancel} />
                            ) : null}

                            {Platform.OS === 'ios' && (
                                <VStack space="sm">
                                    {/* Read BEFORE the picker opens. Once Apple's
                                        "Required Downloads" sheet is up it covers the
                                        lower half of the screen, so this is the last
                                        calm moment to say what that sheet expects. The
                                        icon is inline so the glyph to look for is
                                        unmistakable. */}
                                    <Text
                                        testID="language-download-hint"
                                        className="text-typography-400 text-xs leading-5"
                                    >
                                        {t('language.downloadHintBeforePrefix')}{' '}
                                        <MaterialCommunityIcons
                                            name="arrow-down-circle-outline"
                                            size={14}
                                            color="#a78bfa"
                                        />
                                        {' '}{t('language.downloadHintBeforeSuffix')}
                                    </Text>
                                    {/* On-device translation is the OPTIONAL path.
                                        A reader who cannot or will not download a
                                        pack must leave this screen knowing they can
                                        still read everything — hence Google Translate
                                        stated first, and named exactly as the button
                                        on the article page is labelled. */}
                                    <Text className="text-typography-400 text-xs leading-5">
                                        {t('language.iosLanguageHint')}
                                    </Text>
                                    <Pressable
                                        onPress={handleWatchGuide}
                                        className="flex-row items-center py-3 px-4 bg-gray-800 rounded-lg border border-gray-700"
                                    >
                                        <MaterialIcons name="play-circle-filled" size={20} color="#a78bfa" style={{ marginRight: 8 }} />
                                        <Text className="text-violet-400 text-sm font-medium flex-1">
                                            {t('language.watchGuide')}
                                        </Text>
                                    </Pressable>
                                </VStack>
                            )}
                        </VStack>

                        <Box className="border-b border-gray-800" />

                        {/* Language Packs */}
                        <VStack space="md" style={{ paddingBottom: insets.bottom + 32 }}>
                            <HStack space="md" className="items-center">
                                <MaterialIcons name="cloud-download" size={24} color="#f59e0b" />
                                <Text className="text-white text-lg font-semibold">
                                    {t('language.languagePacks')}
                                </Text>
                            </HStack>

                            {/* The guide video used to be offered twice on this one
                                screen. The copy above already links it, in the place
                                where the reader is being told to check iOS settings —
                                a second identical button here only made the screen
                                look like it had two different videos. */}
                            <Box className="p-4 bg-gray-800 rounded-lg border border-gray-700">
                                {Platform.OS === 'ios' ? (
                                    <VStack space="sm">
                                        <Text className="text-typography-400 text-sm leading-5">
                                            {t('language.languagePacksIos')}
                                        </Text>
                                        <Text className="text-typography-400 text-sm leading-5">
                                            {t('language.managePacksPrefix')}{' '}
                                            <Text className="text-white text-sm font-medium">
                                                {t('language.languagePacksIosPath')}
                                            </Text>
                                            .
                                        </Text>
                                        <Pressable
                                            onPress={() => Linking.openURL('App-Prefs:General')}
                                            className="flex-row items-center mt-2 py-2.5 px-3 bg-gray-700 rounded-lg"
                                        >
                                            <MaterialIcons name="open-in-new" size={16} color="#a78bfa" style={{ marginRight: 8 }} />
                                            <Text className="text-violet-400 text-sm font-medium">
                                                {t('language.openLanguageSettings')}
                                            </Text>
                                        </Pressable>
                                    </VStack>
                                ) : (
                                    <VStack space="sm">
                                        <Text className="text-typography-400 text-sm leading-5">
                                            {t('language.languagePacksAndroid')}
                                        </Text>
                                        <Pressable
                                            onPress={() => Linking.sendIntent('android.settings.LOCALE_SETTINGS')}
                                            className="flex-row items-center mt-2 py-2.5 px-3 bg-gray-700 rounded-lg"
                                        >
                                            <MaterialIcons name="open-in-new" size={16} color="#a78bfa" style={{ marginRight: 8 }} />
                                            <Text className="text-violet-400 text-sm font-medium">
                                                {t('language.openLanguageSettings')}
                                            </Text>
                                        </Pressable>
                                    </VStack>
                                )}
                            </Box>

                        </VStack>

                    </VStack>
                </ScrollView>
            </Box>

            {/* Language Picker Modal */}
            <Modal
                visible={showLangPicker}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setShowLangPicker(false)}
                // THE HANDSHAKE. iOS fires this once the dismissal transition
                // has actually finished; only then may the probe present
                // Apple's system sheet. Presenting it during the dismissal is
                // a hard native crash — see lib/hooks/use-language-switch.ts.
                onDismiss={notifyPickerDismissed}
            >
                <GluestackUIProvider mode="dark">
                    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 16 }}>
                        <HStack className="items-center justify-between px-5 pb-4">
                            <Text className="text-white text-xl font-semibold">
                                {t('language.appLanguage')}
                            </Text>
                            <Pressable onPress={() => setShowLangPicker(false)}>
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
                                                className={isSelected ? 'text-violet-400 font-semibold' : 'text-white'}
                                            >
                                                {item.name}
                                            </Text>
                                            <Text className="text-gray-400 text-sm">
                                                {item.native}
                                            </Text>
                                        </VStack>
                                        {isSelected && (
                                            <MaterialIcons name="check" size={20} color="#a78bfa" />
                                        )}
                                    </TouchableOpacity>
                                );
                            }}
                            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
                        />
                    </Box>
                </GluestackUIProvider>
            </Modal>

            <VideoPlayerModal
                visible={showGuideVideo}
                uri={TRANSLATION_GUIDE_URL}
                onClose={() => setShowGuideVideo(false)}
            />
        </GluestackUIProvider>
    );
};

export default LanguageSettingsScreen;
