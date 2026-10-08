import * as Device from 'expo-device';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { LanguageRow } from '@/components/custom/auth/LanguageRow';
import RotatingLanguageHeading from '@/components/custom/auth/RotatingLanguageHeading';
import DownloadPressIllustration from '@/components/custom/auth/DownloadPressIllustration';
import { Button, ButtonText } from '@/components/ui/button';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { useCurrentProbe, useLanguageSwitch, type LanguageSwitchResult, type Probe } from '@/lib/hooks/use-language-switch';
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

const RTL_CODES = new Set(['ar', 'he']);
/** The notice is the light theme's card in both themes. */
const NOTICE_INK = COLORS.light.ink;
const NOTICE_BASE = COLORS.light.base;

/**
 * A probe for a pack that is already there settles in well under this, with
 * no sheet. Waiting it out keeps the notice from flashing in that case.
 */
const NOTICE_DELAY_MS = 300;

/**
 * A probe this far in with no sign of Apple's sheet is not going to show one
 * (a call left over from an earlier attempt can hold the native host). The
 * reader is let go; the call itself keeps its real 90s / 20s timeout.
 */
const NO_SHEET_MS = 8000;

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
 * Owner rule: the download notice shows ONLY while Apple's sheet is up. JS gets
 * no sheet event, so it rides the probe call (`useProbingLanguage`): iOS only,
 * after NOTICE_DELAY_MS, gone the moment the call settles. If no sheet shows by
 * NO_SHEET_MS the page lets the reader go: notice off, list unlocked, pick
 * snapped back, and a toast pointing at iOS Settings.
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
    const { requestSwitch, busy, pendingCode, cancel } = useLanguageSwitch({ preview: false, immediate: true, onResult });
    const cancelRef = useRef(cancel);
    cancelRef.current = cancel;

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

    const probe = useCurrentProbe();
    // The probe the page gave up on (no sheet came). Its call may stay open
    // natively for its whole timeout; the page no longer waits on it.
    const [gaveUp, setGaveUp] = useState<Probe | null>(null);
    const live = Platform.OS === 'ios' && probe && probe !== gaveUp ? probe.code : null;

    // The list locks at once, with no delay: a second tap inside the notice
    // delay would start a second probe, i.e. a second sheet.
    const waiting = busy || (startup === 'checking' && gaveUp?.code !== appLanguage);

    const [noticeCode, setNoticeCode] = useState<string | null>(null);
    useEffect(() => {
        if (!live) {
            setNoticeCode(null);
            return;
        }
        const id = setTimeout(() => setNoticeCode(live), NOTICE_DELAY_MS);
        return () => clearTimeout(id);
    }, [live, probe]);

    // No-sheet fallback. Apple's sheet sends JS no event; iOS reporting the app
    // inactive is the one outside sign of a system sheet, and a probe that has
    // seen it is waiting on the reader, so it is never cut short.
    useEffect(() => {
        if (!live || !probe) return;
        let sheetSeen = AppState.currentState !== 'active';
        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') sheetSeen = true;
        });
        const id = setTimeout(() => {
            if (sheetSeen) return;
            setGaveUp(probe);
            cancelRef.current();
            const language = getNativeLanguageName(live) ?? live;
            notify(
                `auth-language-nosheet-${live}`,
                t('auth.track.noSheetTitle', { defaultValue: "Your iPhone didn't open the download" }),
                t('auth.track.noSheetBody', {
                    language,
                    defaultValue:
                        'Try again, or download {{language}} in Settings › General › Language & Region › Translation Languages.',
                }),
            );
        }, NO_SHEET_MS);
        return () => {
            clearTimeout(id);
            sub.remove();
        };
    }, [live, probe, notify, t]);

    const languages = useMemo(() => {
        const offered = SUPPORTED_LANGUAGES.filter((l) => l.code === 'en' || canTranslateIntoLanguage(l.code));
        const rank = (code: string) => (code === phone ? 0 : code === 'en' ? 1 : 2);
        return [...offered].sort((a, b) => rank(a.code) - rank(b.code));
    }, [phone]);

    const pick = useCallback(
        (code: string) => {
            if (waiting || code === appLanguage) return;
            requestSwitch(code);
        },
        [waiting, appLanguage, requestSwitch],
    );

    // The notice speaks the language being fetched: the reader picked it, and
    // iOS dims the rest of the screen while it asks. "Not on this phone" stays
    // in the language the app is in, the one the reader has now.
    const lt = noticeCode ? i18n.getFixedT(noticeCode) : t;
    const messageDir = noticeCode && RTL_CODES.has(noticeCode) ? 'rtl' : 'ltr';
    const messageTitle = noticeCode
        ? lt('auth.track.gettingReadyTitle', { language: getNativeLanguageName(noticeCode) ?? noticeCode })
        : '';
    const messageBody = noticeCode ? lt('auth.track.gettingReadyIos') : '';

    return (
        <View style={styles.root} testID="auth-welcome-stage">
            {noticeCode ? (
                <Animated.View
                    key={noticeCode}
                    entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(220)}
                    exiting={FadeOut.duration(220)}
                    accessibilityLiveRegion="polite"
                    // A white card with dark ink in BOTH themes: iOS's download
                    // sheet dims everything behind it, and this card has to read
                    // through that. A hairline edge keeps it apart from a light page.
                    style={[styles.message, { top: messageTop }]}
                    testID="auth-language-message-getting"
                >
                    <DownloadPressIllustration />
                    <View style={styles.messageText}>
                        <Text style={[styles.messageTitle, { color: NOTICE_INK, writingDirection: messageDir }]}>{messageTitle}</Text>
                        <Text style={[styles.messageBody, { color: NOTICE_INK, writingDirection: messageDir }]}>
                            {/* The ↓ stands for iOS's download button: drawn in the
                                same blue as the illustration and the iOS icon. */}
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
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: COLORS.light.line,
        backgroundColor: NOTICE_BASE,
    },
    messageText: { flex: 1, gap: 6 },
    messageTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
    messageBody: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
    downArrow: { color: COLORS.light.info, fontWeight: '800' },
    title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
    label: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
    labelBox: { marginTop: 8, marginBottom: 12 },
    list: { flex: 1, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 4, overflow: 'hidden' },
    actions: { gap: 10, marginTop: 16 },
});
