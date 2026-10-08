import * as Device from 'expo-device';
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    FadeIn,
    FadeInDown,
    FadeOut,
    FadeOutDown,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { LanguageRow } from '@/components/custom/auth/LanguageRow';
import RotatingLanguageHeading from '@/components/custom/auth/RotatingLanguageHeading';
import MeraLogo from '@/components/custom/MeraLogo';
import { Button, ButtonText } from '@/components/ui/button';
import { useLanguageSwitch, type LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import { phoneLanguage, useAppLanguageStore } from '@/lib/stores/app-language-store';
import { languageCheckStatus } from '@/lib/system-check/system-check';
import i18n from '@/lib/i18n';
import { COLORS, useColors } from '@/lib/theme/tokens';
import {
    canTranslateIntoLanguage,
    getNativeLanguageName,
    isTranslationVerified,
    subscribeTranslationAvailability,
    SUPPORTED_LANGUAGES,
    useTranslationBlocked,
} from '@/lib/translation-service';

type Message = { kind: 'getting' | 'missing' | 'ready'; code: string } | null;

const RTL_CODES = new Set(['ar', 'he']);
/** The notice is the light theme's card in both themes. */
const NOTICE_INK = COLORS.light.ink;
const NOTICE_BASE = COLORS.light.base;
/** The orange glow's alpha range; it breathes slowly unless Reduce Motion. */
const GLOW_LOW = 0.3;
const GLOW_HIGH = 0.5;
const GLOW_BREATH_MS = 1600;

/** "X is ready" stays this long, then fades (Journey #13). */
const READY_MESSAGE_MS = 1500;

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
 * Apple's download sheet, while a message card says what is happening and the
 * ways in step away. The page turns to the new language only once it is ready.
 *
 * Owner rule: a language the phone cannot translate into is never offered, and
 * one that turns out missing falls back to English, with no continue-anyway.
 * The list never fires a second probe beside the startup one
 * (TranslationUnavailablePrompt): while that one runs, this page shows the same
 * "Getting X ready" message for the preselected language.
 */
export default function WelcomeStage({ messageTop, onBegin, onLearn }: WelcomeStageProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const glow = useSharedValue((GLOW_LOW + GLOW_HIGH) / 2);
    const glowStyle = useAnimatedStyle(() => ({ shadowOpacity: glow.value }));
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

    // The notice's glow breathes only while a notice shows, never under Reduce Motion.
    const noticeShown = shown !== null;
    useEffect(() => {
        if (!noticeShown || reduceMotion) {
            cancelAnimation(glow);
            glow.value = (GLOW_LOW + GLOW_HIGH) / 2;
            return;
        }
        glow.value = GLOW_LOW;
        glow.value = withRepeat(withTiming(GLOW_HIGH, { duration: GLOW_BREATH_MS, easing: Easing.inOut(Easing.ease) }), -1, true);
    }, [noticeShown, reduceMotion, glow]);

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
    // Getting X ready / X is ready speak X itself: the reader picked it, and
    // iOS dims the rest of the screen while it asks. "Not on this phone" stays
    // in the language the app is in, the one the reader has now.
    const lt = shown && shown.kind !== 'missing' ? i18n.getFixedT(shown.code) : t;
    const messageDir = shown && shown.kind !== 'missing' && RTL_CODES.has(shown.code) ? 'rtl' : 'ltr';
    const messageTitle =
        shown?.kind === 'getting'
            ? lt('auth.track.gettingReadyTitle', { language: name(shown.code) })
            : shown?.kind === 'missing'
              ? t('auth.track.notHereTitle', { language: name(shown.code) })
              : shown?.kind === 'ready'
                ? lt('auth.track.readyTitle', { language: name(shown.code) })
                : '';
    const messageBody =
        shown?.kind === 'getting'
            ? lt(Platform.OS === 'ios' ? 'auth.track.gettingReadyIos' : 'auth.track.gettingReadyOther')
            : shown?.kind === 'missing'
              ? t('auth.track.notHereBody')
              : shown?.kind === 'ready'
                ? lt('auth.track.readyBody', { language: name(shown.code) })
                : '';

    return (
        <View style={styles.root} testID="auth-welcome-stage">
            {shown ? (
                <Animated.View
                    key={`${shown.kind}-${shown.code}`}
                    entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(220)}
                    exiting={FadeOut.duration(220)}
                    accessibilityLiveRegion="polite"
                    // A white card with dark ink in BOTH themes, an orange edge
                    // and a soft orange glow: iOS's download sheet dims
                    // everything behind it, and this card has to read through it.
                    style={[styles.message, { top: messageTop, borderColor: colors.accent, shadowColor: colors.accent }, glowStyle]}
                    testID={`auth-language-message-${shown.kind}`}
                >
                    {shown.kind === 'getting' ? <MeraLogo size={32} animated color={NOTICE_INK} /> : null}
                    <View style={styles.messageText}>
                        <Text style={[styles.messageTitle, { color: NOTICE_INK, writingDirection: messageDir }]}>{messageTitle}</Text>
                        <Text style={[styles.messageBody, { color: NOTICE_INK, writingDirection: messageDir }]}>
                            {/* The ↓ stands for iOS's download button: drawn in the
                                light theme's orange text colour so it stands out. */}
                            {messageBody.split('↓').map((part, i) =>
                                i === 0 ? (
                                    part
                                ) : (
                                    <React.Fragment key={i}>
                                        <Text style={styles.downArrow}>↓</Text>
                                        {part}
                                    </React.Fragment>
                                ),
                            )}
                        </Text>
                    </View>
                </Animated.View>
            ) : null}

            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('auth.track.welcome')}
            </Text>
            <RotatingLanguageHeading phone={phone} style={[styles.label, { color: colors.ink3 }]} containerStyle={styles.labelBox} />

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
        gap: 14,
        padding: 20,
        borderRadius: 20,
        borderWidth: 2,
        backgroundColor: NOTICE_BASE,
        shadowOffset: { width: 0, height: 0 },
        shadowRadius: 14,
        elevation: 12,
    },
    messageText: { flex: 1, gap: 6 },
    messageTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
    messageBody: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
    downArrow: { color: COLORS.light.accentText, fontWeight: '800' },
    title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
    label: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
    labelBox: { marginTop: 8, marginBottom: 12 },
    list: { flex: 1, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 4, overflow: 'hidden' },
    actions: { gap: 10, marginTop: 16 },
});
