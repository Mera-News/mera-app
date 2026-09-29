import { MaterialIcons } from '@expo/vector-icons';
import * as Device from 'expo-device';
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import MeraLogo from '@/components/custom/MeraLogo';
import CheckRing from '@/components/custom/system-check/CheckRing';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { hapticLight } from '@/lib/haptics';
import { useLanguageSwitch } from '@/lib/hooks/use-language-switch';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { describeDevice, languageCheckStatus } from '@/lib/system-check/system-check';
import {
    getNativeLanguageName,
    isTranslationVerified,
    probeTranslationLanguage,
    subscribeTranslationAvailability,
    useTranslationBlocked,
} from '@/lib/translation-service';

/** The three device checks settle one after another at this pace, so the ring
 *  reads as a sequence. They are instant underneath; this is presentation. */
const STEP_MS = 450;
/** The startup probe gives up at 20s (TRANSLATION_STARTUP_VERIFY_TIMEOUT_MS).
 *  Past this, stop waiting on it and offer a deliberate retry instead. */
const LANGUAGE_WAIT_MS = 25_000;
const DEVICE_STEPS = 3;
const TOTAL_STEPS = DEVICE_STEPS + 1;

type RowState = 'pending' | 'ok' | 'info' | 'warn';

const CheckRow: React.FC<{ state: RowState; title: string; detail?: string; testID: string }> = ({
    state,
    title,
    detail,
    testID,
}) => (
    <HStack testID={testID} space="md" className="items-start py-2">
        <Box className="w-6 items-center pt-0.5">
            {state === 'pending' ? (
                <Spinner size="small" color="#9ca3af" />
            ) : (
                <MaterialIcons
                    name={state === 'ok' ? 'check-circle' : state === 'warn' ? 'error-outline' : 'info-outline'}
                    size={20}
                    color={state === 'ok' ? '#10b981' : state === 'warn' ? '#f59e0b' : '#9ca3af'}
                />
            )}
        </Box>
        <VStack className="flex-1">
            <Text className="text-white text-base">{title}</Text>
            {detail ? <Text size="sm" className="text-gray-400 mt-0.5">{detail}</Text> : null}
        </VStack>
    </HStack>
);

interface SystemCheckStageProps {
    /** The checks passed and the language is persisted; move on. */
    onContinue: () => void;
    testID?: string;
}

/**
 * The first-launch stage (it replaced the bare language stage in AuthScreen)
 * and the Settings "System check" screen. Four checks fill the ring: the
 * phone, how Mera will run on it (Full or Lite), on-device AI, and the
 * language pack. Continue opens only when the language is one this phone can
 * translate into, or English: that is the owner's rule, with no way past it.
 */
const SystemCheckStage: React.FC<SystemCheckStageProps> = ({ onContinue, testID = 'system-check' }) => {
    const { t } = useTranslation();
    const liteMode = useDisplayPrefsStore((s) => s.liteMode);
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);

    const [stepsDone, setStepsDone] = useState(0);
    useEffect(() => {
        if (stepsDone >= DEVICE_STEPS) return;
        const id = setTimeout(() => setStepsDone((n) => n + 1), STEP_MS);
        return () => clearTimeout(id);
    }, [stepsDone]);

    // The language verdict comes from the probe TranslationUnavailablePrompt
    // runs at startup, read through the shared availability store. This screen
    // never starts a second automatic probe: each may present Apple's sheet.
    const blocked = useTranslationBlocked(appLanguage) != null;
    const verified = useSyncExternalStore(subscribeTranslationAvailability, () => isTranslationVerified(appLanguage));
    const languageStatus = languageCheckStatus({
        appLanguage,
        verified,
        blocked,
        isPhysicalDevice: Device.isDevice !== false,
    });

    const [waitedTooLong, setWaitedTooLong] = useState(false);
    const [retrying, setRetrying] = useState(false);
    useEffect(() => {
        setWaitedTooLong(false);
        if (languageStatus !== 'checking') return;
        const id = setTimeout(() => setWaitedTooLong(true), LANGUAGE_WAIT_MS);
        return () => clearTimeout(id);
    }, [languageStatus, appLanguage]);

    const retry = useCallback(async () => {
        if (retrying) return;
        setRetrying(true);
        void hapticLight();
        try {
            await probeTranslationLanguage(appLanguage);
        } finally {
            setRetrying(false);
        }
    }, [appLanguage, retrying]);

    const { requestSwitch, busy: switching } = useLanguageSwitch();
    const useEnglish = useCallback(() => {
        void hapticLight();
        requestSwitch('en');
    }, [requestSwitch]);

    const [saving, setSaving] = useState(false);
    const languageReady = stepsDone >= DEVICE_STEPS && languageStatus === 'passed';
    const handleContinue = useCallback(async () => {
        if (saving || !languageReady) return;
        setSaving(true);
        void hapticLight();
        try {
            // Writes the `app_language` row whose absence is AuthScreen's "show
            // this stage" signal, so the stage shows once per install.
            await useAppLanguageStore.getState().setAppLanguage(useAppLanguageStore.getState().appLanguage);
        } catch {
            // The store logs its own failures; a missed persist only shows this
            // stage once more next launch.
        }
        onContinue();
    }, [languageReady, onContinue, saving]);

    const progress = (Math.min(stepsDone, DEVICE_STEPS) + (languageStatus === 'passed' ? 1 : 0)) / TOTAL_STEPS;
    const languageName = getNativeLanguageName(appLanguage) ?? appLanguage;
    const deviceLine = describeDevice({
        modelName: Device.modelName ?? null,
        osName: Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : null,
        osVersion: Device.osVersion ?? null,
        totalMemory: Device.totalMemory ?? null,
        memoryLabel: (gb) => t('systemCheck.memory', { gb }),
    });

    const languageDetail =
        languageStatus === 'passed'
            ? appLanguage === 'en'
                ? t('systemCheck.languageEnglish')
                : t('systemCheck.languageReady')
            : languageStatus === 'needs-english'
              ? t('systemCheck.languageMissing', { language: languageName })
              : t('systemCheck.languageChecking');

    return (
        <Box testID={testID} accessible={false} className="flex-1 px-5">
            <Box accessible={false} className="items-center justify-center" style={{ flex: 3 }}>
                <CheckRing progress={progress} size={168}>
                    <MeraLogo size={96} animated />
                </CheckRing>
            </Box>

            <VStack accessible={false} space="xs" className="mb-3">
                <Text size="2xl" className="text-white font-semibold text-center">
                    {t('systemCheck.title')}
                </Text>
                <Text size="sm" className="text-gray-400 text-center">
                    {t('systemCheck.subtitle')}
                </Text>
            </VStack>

            <VStack accessible={false} className="mb-3">
                <CheckRow
                    testID={`${testID}-phone`}
                    state={stepsDone >= 1 ? 'ok' : 'pending'}
                    title={t('systemCheck.phoneTitle')}
                    detail={stepsDone >= 1 ? t('systemCheck.phoneSupported', { details: deviceLine }) : undefined}
                />
                <CheckRow
                    testID={`${testID}-mode`}
                    state={stepsDone >= 2 ? 'ok' : 'pending'}
                    title={stepsDone >= 2 ? (liteMode ? t('systemCheck.modeLite') : t('systemCheck.modeFull')) : t('systemCheck.modeTitle')}
                    detail={stepsDone >= 2 ? (liteMode ? t('systemCheck.modeLiteDetail') : t('systemCheck.modeFullDetail')) : undefined}
                />
                <CheckRow
                    testID={`${testID}-ai`}
                    state={stepsDone >= 3 ? 'info' : 'pending'}
                    title={t('systemCheck.aiTitle')}
                    detail={stepsDone >= 3 ? t('systemCheck.aiNotYet') : undefined}
                />
                <CheckRow
                    testID={`${testID}-language`}
                    state={
                        stepsDone < DEVICE_STEPS || (languageStatus === 'checking' && !waitedTooLong) || retrying
                            ? 'pending'
                            : languageStatus === 'passed'
                              ? 'ok'
                              : 'warn'
                    }
                    title={t('systemCheck.languageTitle', { language: languageName })}
                    detail={stepsDone >= DEVICE_STEPS ? languageDetail : undefined}
                />
            </VStack>

            <VStack accessible={false} space="md">
                <LanguageSelector />

                {stepsDone >= DEVICE_STEPS && (languageStatus === 'needs-english' || waitedTooLong) ? (
                    <HStack space="sm">
                        <Pressable
                            testID={`${testID}-retry`}
                            onPress={retry}
                            disabled={retrying || switching}
                            accessibilityRole="button"
                            className="flex-1 h-12 rounded-full items-center justify-center border border-gray-600"
                        >
                            <Text className="text-white text-base">{t('systemCheck.retry')}</Text>
                        </Pressable>
                        <Pressable
                            testID={`${testID}-use-english`}
                            onPress={useEnglish}
                            disabled={retrying || switching}
                            accessibilityRole="button"
                            className="flex-1 h-12 rounded-full items-center justify-center border border-gray-600"
                        >
                            <Text className="text-white text-base">{t('systemCheck.useEnglish')}</Text>
                        </Pressable>
                    </HStack>
                ) : null}

                <Pressable
                    testID={`${testID}-continue`}
                    onPress={handleContinue}
                    disabled={!languageReady || saving}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={t('auth.continue')}
                    accessibilityState={{ disabled: !languageReady || saving, busy: saving }}
                    className={`h-14 rounded-full items-center justify-center ${languageReady && !saving ? 'bg-primary-500' : 'bg-gray-700'}`}
                >
                    {saving ? (
                        <Spinner size="small" color="white" />
                    ) : (
                        <Text className={languageReady ? 'text-black text-base font-semibold' : 'text-gray-400 text-base font-semibold'}>
                            {t('auth.continue')}
                        </Text>
                    )}
                </Pressable>
            </VStack>

            <Box style={{ flex: 1 }} />
        </Box>
    );
};

export default SystemCheckStage;
