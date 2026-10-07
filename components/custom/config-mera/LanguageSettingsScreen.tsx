import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { Group, Help, Row } from '@/components/custom/you/rows';
import { getLanguageName, SUPPORTED_LANGUAGES } from '@/lib/translation-service';
import { requestRestart } from '@/lib/app-restart';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useLanguageSwitch, LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import LanguageSwitchProgress from '@/components/custom/config-mera/LanguageSwitchProgress';
import LanguageDownloadHint from '@/components/custom/config-mera/LanguageDownloadHint';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { FlatList, Modal, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { showDialog } from '@/lib/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';

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
    const selectedLanguage = SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage);

    // Only fires on a language that was actually applied, so a failed attempt
    // can never prompt for a restart the user did not ask for.
    const handleCommitted = useCallback(
        (code: string, previousCode: string) => {
            if (RTL_CODES.has(previousCode) === RTL_CODES.has(code)) return;
            void showDialog({
                title: t('language.restartRequired'),
                body: t('language.restartDescription'),
                cancelLabel: t('language.later'),
                confirmLabel: t('language.restart'),
            }).then((restart) => {
                // Through the one restart authority, not a bare
                // reloadAsync(): lib/app-restart.ts holds this off while a
                // purchase or a credential write is mid-flight.
                if (restart) void requestRestart('language');
            });
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
                void showDialog({
                    title: t('language.switchFailedTitle', { language }),
                    body: t('language.switchDeviceUnsupportedBody', { language }),
                    confirmLabel: t('common.ok'),
                });
                return;
            }
            const body = outcome === 'timeout'
                ? t('language.switchTimedOutBody', { language, previous: current })
                : outcome === 'language-unsupported'
                    ? t('language.switchUnsupportedBody', { language, previous: current })
                    : t('language.switchFailedBody', { language, previous: current });
            void showDialog({ title: t('language.switchFailedTitle', { language }), body, confirmLabel: t('common.ok') });
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

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader
                        title={t('language.title')}
                        onBack={onBack ? handleBack : undefined}
                        backTestID="language-back"
                        // Locked while a switch runs: Apple's system sheet
                        // must not be left half-done.
                        backDisabled={busy}
                    />
                </Box>

                <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: insets.bottom + 32, gap: 12 }}>
                    <Group>
                        <Row
                            testID="language-current-row"
                            title={t('language.appLanguage')}
                            subtitle={t('language.appLanguageDescription')}
                            value={selectedLanguage?.native ?? 'English'}
                            onPress={busy ? undefined : () => setShowLangPicker(true)}
                        />
                    </Group>
                    {busy && pendingCode ? <LanguageSwitchProgress code={pendingCode} onCancel={cancel} /> : null}
                    {/* One line, written for the phone it is on (FinalSettings #5). */}
                    <Help>{Platform.OS === 'ios' ? t('language.oneParaIos') : t('language.oneParaAndroid')}</Help>
                    {/* Read BEFORE the picker opens: once Apple's Required
                        Downloads sheet is up it covers the lower half of the
                        screen. iOS-only, from inside the component. */}
                    <LanguageDownloadHint />
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
                        {/* The modal material (components/ui/modal). */}
                        <AbstractGradientBackdrop seed="mera-modal" frame={0} />
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
