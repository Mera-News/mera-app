import * as Device from 'expo-device';
import React, { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import RotatingLanguageHeading from '@/components/custom/auth/RotatingLanguageHeading';
import LanguageDownloadNotice, { useLanguageDownloadNotice } from '@/components/custom/auth/LanguageDownloadNotice';
import { Button, ButtonText } from '@/components/ui/button';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { useLanguageSwitch, type LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import { phoneLanguage, useAppLanguageStore } from '@/lib/stores/app-language-store';
import { languageCheckStatus } from '@/lib/system-check/system-check';
import { useColors } from '@/lib/theme/tokens';
import {
    getNativeLanguageName,
    isTranslationVerified,
    subscribeTranslationAvailability,
    useTranslationBlocked,
} from '@/lib/translation-service';

interface WelcomeStageProps {
    /** The message card's top in this view's coordinates: the screen top plus
     *  a margin, less where this view starts (Journey #10: it drops from the top). */
    messageTop: number;
    /** "Begin Mera": on to Checking your phone. */
    onBegin: () => void;
    /** "Learn about Mera": the tour sheet over this page. */
    onLearn: () => void;
}

/**
 * Stop 2 of the first-launch track (FinalJourney #4, #9 to #13): the welcome
 * line, the language list with the phone's language first and already picked,
 * and the two ways in. A language this phone still needs shows a download
 * button; picking it (or tapping the button) runs the ONE probe that may show
 * Apple's download sheet, and the ways in step away. The page turns to the new
 * language only once it is ready; the list's tick says so, with no message.
 *
 * The download notice and its sheet guards are `LanguageDownloadNotice` (shared
 * with Settings > Language); when no sheet shows, the page lets the reader go
 * with a toast pointing at iOS Settings.
 *
 * Owner rule: a language the phone cannot translate into is never offered, and
 * one that turns out missing falls back to English, with no continue-anyway;
 * a toast says so. The list never fires a second probe beside the startup one
 * (TranslationUnavailablePrompt), which drives the same notice.
 */
export default function WelcomeStage({ messageTop, onBegin, onLearn }: WelcomeStageProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const phone = useMemo(() => phoneLanguage(), []);
    const toast = useToast();

    const notify = useCallback(
        (id: string, title: string, body: string) => {
            if (toast.isActive(id)) return;
            toast.show({
                id,
                placement: 'top',
                render: () => (
                    <Toast action="info" variant="solid">
                        <ToastTitle>{title}</ToastTitle>
                        <ToastDescription>{body}</ToastDescription>
                    </Toast>
                ),
            });
        },
        [toast],
    );
    const showMissing = useCallback(
        (code: string) => {
            const language = getNativeLanguageName(code) ?? code;
            notify(`auth-language-missing-${code}`, t('auth.track.notHereTitle', { language }), t('auth.track.notHereBody'));
        },
        [notify, t],
    );
    const onResult = useCallback((r: LanguageSwitchResult) => showMissing(r.code), [showMissing]);
    const { requestSwitch, busy, pendingCode, cancel } = useLanguageSwitch({ preview: false, onResult });

    // The startup probe for the preselected language (never a second probe).
    const blocked = useTranslationBlocked(appLanguage) != null;
    const verified = useSyncExternalStore(subscribeTranslationAvailability, () => isTranslationVerified(appLanguage));
    const startup = languageCheckStatus({ appLanguage, verified, blocked, isPhysicalDevice: Device.isDevice !== false });

    // A preselected language this phone turns out not to have: English, with
    // a toast saying so (owner rule: no continue-anyway).
    useEffect(() => {
        if (startup !== 'needs-english' || appLanguage === 'en' || busy) return;
        showMissing(appLanguage);
        void useAppLanguageStore.getState().setAppLanguage('en');
    }, [startup, appLanguage, busy, showMissing]);

    const onNoSheet = useCallback(
        (code: string) => {
            const language = getNativeLanguageName(code) ?? code;
            notify(`auth-language-nosheet-${code}`, t('auth.track.noSheetTitle'), t('auth.track.noSheetBody', { language }));
        },
        [notify, t],
    );
    const { noticeCode, gaveUp } = useLanguageDownloadNotice(cancel, onNoSheet);

    // The list locks at once, with no delay: a second tap inside the notice
    // delay would start a second probe, i.e. a second sheet.
    const waiting = busy || (startup === 'checking' && gaveUp?.code !== appLanguage);

    const pick = useCallback(
        (code: string) => {
            if (waiting || code === appLanguage) return;
            requestSwitch(code);
        },
        [waiting, appLanguage, requestSwitch],
    );

    return (
        <View style={styles.root} testID="auth-welcome-stage">
            <LanguageDownloadNotice code={noticeCode} top={messageTop} />

            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('auth.track.welcome')}
            </Text>
            <RotatingLanguageHeading phone={phone} style={[styles.label, { color: colors.ink3 }]} containerStyle={styles.labelBox} />

            <LanguageSelector
                appLanguage={appLanguage}
                phone={phone}
                busy={busy}
                pendingCode={pendingCode}
                locked={waiting}
                onPick={pick}
                testIDPrefix="auth-language"
            />

            {!waiting ? (
                <Animated.View
                    entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(300)}
                    exiting={reduceMotion ? FadeOut.duration(150) : FadeOutDown.duration(220)}
                    style={styles.actions}
                >
                    <Button action="primary" onPress={onBegin} testID="auth-begin-mera">
                        <ButtonText>{t('auth.track.beginMera')}</ButtonText>
                    </Button>
                    <Button variant="outline" action="secondary" onPress={onLearn} testID="auth-learn-mera">
                        <ButtonText>{t('auth.learnAboutMera')}</ButtonText>
                    </Button>
                </Animated.View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: 20, paddingBottom: 16 },
    title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
    label: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
    labelBox: { marginTop: 8, marginBottom: 12 },
    actions: { gap: 10, marginTop: 16 },
});
