import * as Device from 'expo-device';
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { LanguageRow } from '@/components/custom/auth/LanguageRow';
import MeraLogo from '@/components/custom/MeraLogo';
import { Button, ButtonText } from '@/components/ui/button';
import { useLanguageSwitch, type LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import { phoneLanguage, useAppLanguageStore } from '@/lib/stores/app-language-store';
import { languageCheckStatus } from '@/lib/system-check/system-check';
import { useColors } from '@/lib/theme/tokens';
import {
    canTranslateIntoLanguage,
    getNativeLanguageName,
    isTranslationVerified,
    subscribeTranslationAvailability,
    SUPPORTED_LANGUAGES,
    useTranslationBlocked,
} from '@/lib/translation-service';

type Message = { kind: 'getting' | 'missing' | 'ready'; code: string } | null;

/** "X is ready" stays this long, then fades (Journey #13). */
const READY_MESSAGE_MS = 1500;

interface WelcomeStageProps {
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
 * Apple's download sheet, while a message card says what is happening and the
 * ways in step away. The page turns to the new language only once it is ready.
 *
 * Owner rule: a language the phone cannot translate into is never offered, and
 * one that turns out missing falls back to English, with no continue-anyway.
 * The list never fires a second probe beside the startup one
 * (TranslationUnavailablePrompt): while that one runs, this page shows the same
 * "Getting X ready" message for the preselected language.
 */
export default function WelcomeStage({ onBegin, onLearn }: WelcomeStageProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const reduceMotion = useReducedMotion();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const phone = useMemo(() => phoneLanguage(), []);
    const [message, setMessage] = useState<Message>(null);

    const onResult = useCallback((r: LanguageSwitchResult) => setMessage({ kind: 'missing', code: r.code }), []);
    const onCommitted = useCallback((code: string) => setMessage({ kind: 'ready', code }), []);
    const { requestSwitch, busy, pendingCode } = useLanguageSwitch({
        preview: false,
        immediate: true,
        onResult,
        onCommitted,
    });

    // The startup probe for the preselected language (never a second probe).
    const blocked = useTranslationBlocked(appLanguage) != null;
    const verified = useSyncExternalStore(subscribeTranslationAvailability, () => isTranslationVerified(appLanguage));
    const startup = languageCheckStatus({ appLanguage, verified, blocked, isPhysicalDevice: Device.isDevice !== false });

    // A preselected language this phone turns out not to have: English, with
    // the message saying so (owner rule: no continue-anyway).
    useEffect(() => {
        if (startup !== 'needs-english' || appLanguage === 'en' || busy) return;
        setMessage({ kind: 'missing', code: appLanguage });
        void useAppLanguageStore.getState().setAppLanguage('en');
    }, [startup, appLanguage, busy]);

    useEffect(() => {
        if (message?.kind !== 'ready') return;
        const id = setTimeout(() => setMessage(null), READY_MESSAGE_MS);
        return () => clearTimeout(id);
    }, [message]);

    const gettingCode = busy && pendingCode ? pendingCode : startup === 'checking' ? appLanguage : null;
    const shown: Message = gettingCode ? { kind: 'getting', code: gettingCode } : message;
    const waiting = gettingCode !== null;

    const languages = useMemo(() => {
        const offered = SUPPORTED_LANGUAGES.filter((l) => l.code === 'en' || canTranslateIntoLanguage(l.code));
        const rank = (code: string) => (code === phone ? 0 : code === 'en' ? 1 : 2);
        return [...offered].sort((a, b) => rank(a.code) - rank(b.code));
    }, [phone]);

    const pick = useCallback(
        (code: string) => {
            if (waiting || code === appLanguage) return;
            setMessage(null);
            requestSwitch(code);
        },
        [waiting, appLanguage, requestSwitch],
    );

    const name = (code: string) => getNativeLanguageName(code) ?? code;
    const messageTitle =
        shown?.kind === 'getting'
            ? t('auth.track.gettingReadyTitle', { language: name(shown.code) })
            : shown?.kind === 'missing'
              ? t('auth.track.notHereTitle', { language: name(shown.code) })
              : shown?.kind === 'ready'
                ? t('auth.track.readyTitle', { language: name(shown.code) })
                : '';
    const messageBody =
        shown?.kind === 'getting'
            ? t(Platform.OS === 'ios' ? 'auth.track.gettingReadyIos' : 'auth.track.gettingReadyOther')
            : shown?.kind === 'missing'
              ? t('auth.track.notHereBody')
              : shown?.kind === 'ready'
                ? t('auth.track.readyBody', { language: name(shown.code) })
                : '';

    return (
        <View style={styles.root} testID="auth-welcome-stage">
            {shown ? (
                <Animated.View
                    key={`${shown.kind}-${shown.code}`}
                    entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(220)}
                    exiting={FadeOut.duration(220)}
                    accessibilityLiveRegion="polite"
                    style={[styles.message, { top: insets.top + 8, backgroundColor: colors.panel, borderColor: colors.panelBorder }]}
                    testID={`auth-language-message-${shown.kind}`}
                >
                    {shown.kind === 'getting' ? <MeraLogo size={20} animated /> : null}
                    <View style={styles.messageText}>
                        <Text style={[styles.messageTitle, { color: colors.ink }]}>{messageTitle}</Text>
                        <Text style={[styles.messageBody, { color: colors.ink2 }]}>{messageBody}</Text>
                    </View>
                </Animated.View>
            ) : null}

            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('auth.track.welcome')}
            </Text>
            <Text style={[styles.label, { color: colors.ink3 }]}>{t('auth.track.chooseLanguage')}</Text>

            <View
                pointerEvents={waiting ? 'none' : 'auto'}
                accessibilityRole="radiogroup"
                style={[styles.list, { backgroundColor: colors.surface, borderColor: colors.line }]}
            >
                <FlatList
                    data={languages}
                    keyExtractor={(l) => l.code}
                    renderItem={({ item }) => (
                        <LanguageRow
                            endonym={item.native}
                            english={item.name}
                            isPhoneLanguage={item.code === phone}
                            picked={item.code === (busy && pendingCode ? pendingCode : appLanguage)}
                            accessory={
                                busy && pendingCode === item.code
                                    ? 'busy'
                                    : item.code !== 'en' && !isTranslationVerified(item.code)
                                      ? 'download'
                                      : 'none'
                            }
                            onPress={() => pick(item.code)}
                            onDownload={() => pick(item.code)}
                            downloadA11yLabel={t('auth.track.downloadA11y', { language: item.native })}
                            phoneLanguageLabel={t('auth.track.phoneLanguage')}
                            testID={`auth-language-${item.code}`}
                        />
                    )}
                />
            </View>

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
    message: {
        position: 'absolute',
        left: 16,
        right: 16,
        zIndex: 2,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 14,
        borderRadius: 16,
        borderWidth: 1,
    },
    messageText: { flex: 1, gap: 2 },
    messageTitle: { fontSize: 15, fontWeight: '700' },
    messageBody: { fontSize: 13, lineHeight: 18 },
    title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
    label: { fontSize: 13, textAlign: 'center', marginTop: 8, marginBottom: 12 },
    list: { flex: 1, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 4, overflow: 'hidden' },
    actions: { gap: 10, marginTop: 16 },
});
