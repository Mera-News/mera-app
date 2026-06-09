import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { SUPPORTED_LANGUAGES } from '@/lib/translation-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Alert, FlatList, Linking, Modal, Platform, ScrollView, TouchableOpacity } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as Updates from 'expo-updates';

interface LanguageSettingsScreenProps {
    onBack?: () => void;
}

const RTL_CODES = new Set(['ar', 'he']);

const LanguageSettingsScreen: React.FC<LanguageSettingsScreenProps> = ({ onBack }) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const setAppLanguage = useAppLanguageStore((s) => s.setAppLanguage);
    const showOriginal = useAppLanguageStore((s) => s.showOriginal);
    const setShowOriginal = useAppLanguageStore((s) => s.setShowOriginal);

    const [showLangPicker, setShowLangPicker] = useState(false);
    const [videoLoading, setVideoLoading] = useState(false);

    const handleWatchGuide = async () => {
        setVideoLoading(true);
        try {
            await WebBrowser.openBrowserAsync(TRANSLATION_GUIDE_URL);
        } catch {
            Alert.alert('Error', 'Could not load the guide. Please try again.');
        } finally {
            setVideoLoading(false);
        }
    };

    const selectedLanguage = SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage);

    const handleSelectLanguage = async (code: string) => {
        setShowLangPicker(false);
        const wasRTL = RTL_CODES.has(appLanguage);
        const willBeRTL = RTL_CODES.has(code);
        await setAppLanguage(code);
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
    };

    return (
        <GluestackUIProvider mode="dark">
            <Box className="flex-1 bg-black">
                {/* Floating Back Button */}
                {onBack && (
                    <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                        <Pressable
                            onPress={onBack}
                            className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                        >
                            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
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
                                onPress={() => setShowLangPicker(true)}
                                className="flex-row items-center justify-between py-4 px-4 border border-gray-700 rounded-lg"
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

                            {Platform.OS === 'ios' && (
                                <VStack space="sm">
                                    <Text className="text-typography-500 text-xs leading-5">
                                        Only selecting this language is not enough — you'll need to also select this language in the iOS language settings.
                                    </Text>
                                    <Pressable
                                        onPress={handleWatchGuide}
                                        disabled={videoLoading}
                                        className="flex-row items-center py-3 px-4 bg-gray-800 rounded-lg border border-gray-700"
                                    >
                                        <MaterialIcons name="play-circle-filled" size={20} color="#a78bfa" style={{ marginRight: 8 }} />
                                        <Text className="text-violet-400 text-sm font-medium flex-1">
                                            {videoLoading ? 'Loading…' : t('language.watchGuide')}
                                        </Text>
                                        <MaterialIcons name="open-in-new" size={16} color="#6b7280" />
                                    </Pressable>
                                </VStack>
                            )}
                        </VStack>

                        <Box className="border-b border-gray-800" />

                        {/* Show Original Toggle */}
                        <VStack space="md">
                            <HStack space="md" className="items-center justify-between">
                                <HStack space="md" className="items-center flex-1">
                                    <MaterialIcons name="translate" size={24} color="#10b981" />
                                    <VStack className="flex-1">
                                        <Text className="text-white text-lg font-semibold">
                                            {t('language.showOriginal')}
                                        </Text>
                                        <Text className="text-typography-500 text-sm mt-0.5">
                                            {t('language.showOriginalDescription')}
                                        </Text>
                                    </VStack>
                                </HStack>
                                <Switch
                                    value={showOriginal}
                                    onToggle={setShowOriginal}
                                    size="md"
                                />
                            </HStack>
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

                            <Pressable
                                onPress={handleWatchGuide}
                                disabled={videoLoading}
                                className="flex-row items-center py-3 px-4 bg-gray-800 rounded-lg border border-gray-700"
                            >
                                <MaterialIcons name="play-circle-filled" size={20} color="#a78bfa" style={{ marginRight: 8 }} />
                                <Text className="text-violet-400 text-sm font-medium flex-1">
                                    {videoLoading ? 'Loading…' : 'Watch translation guide'}
                                </Text>
                                <MaterialIcons name="open-in-new" size={16} color="#6b7280" />
                            </Pressable>

                            <Box className="p-4 bg-gray-800 rounded-lg border border-background-700">
                                {Platform.OS === 'ios' ? (
                                    <VStack space="sm">
                                        <Text className="text-typography-400 text-sm leading-5">
                                            {t('language.languagePacksIos')}
                                        </Text>
                                        <Text className="text-typography-400 text-sm leading-5">
                                            To manage downloaded languages, go to{' '}
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
        </GluestackUIProvider>
    );
};

export default LanguageSettingsScreen;
