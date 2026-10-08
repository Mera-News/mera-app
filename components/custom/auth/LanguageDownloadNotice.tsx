// The ONE language download notice (FinalJourney #10), shown by first launch
// and by Settings > Language: "Getting <language> ready" on the LIGHT modal
// material with the pressing-↓ illustration, in the language being fetched.
//
// Owner rule: it shows ONLY while Apple's download sheet is up. JS gets no
// sheet event, so it rides the probe call (`useCurrentProbe`): iOS only, after
// NOTICE_DELAY_MS, gone the moment the call settles. If no sheet shows by
// NO_SHEET_MS the host is let go (`onNoSheet`): notice off, list unlocked, the
// switch cancelled; the call itself keeps its real timeout.

import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, useReducedMotion } from 'react-native-reanimated';

import DownloadPressIllustration from '@/components/custom/auth/DownloadPressIllustration';
import ModalMaterial from '@/components/custom/ModalMaterial';
import { useCurrentProbe, type Probe } from '@/lib/hooks/use-language-switch';
import i18n from '@/lib/i18n';
import { COLORS } from '@/lib/theme/tokens';
import { getNativeLanguageName } from '@/lib/translation-service';

const RTL_CODES = new Set(['ar', 'he']);
/** The notice wears the light theme's modal material and ink in both themes. */
const NOTICE_INK = COLORS.light.ink;

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

/**
 * The notice's guards. `noticeCode` is the language to show the notice for
 * (null: no notice); `gaveUp` is the probe the host stopped waiting on.
 * `cancel` is the host's switch cancel; `onNoSheet` says why it was let go.
 */
export function useLanguageDownloadNotice(cancel: () => void, onNoSheet: (code: string) => void) {
    const probe = useCurrentProbe();
    const [gaveUp, setGaveUp] = useState<Probe | null>(null);
    const live = Platform.OS === 'ios' && probe && probe !== gaveUp ? probe.code : null;
    const cancelRef = useRef(cancel);
    cancelRef.current = cancel;
    const onNoSheetRef = useRef(onNoSheet);
    onNoSheetRef.current = onNoSheet;

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
            onNoSheetRef.current(live);
        }, NO_SHEET_MS);
        return () => {
            clearTimeout(id);
            sub.remove();
        };
    }, [live, probe]);

    return { noticeCode, gaveUp };
}

/** The card itself, absolutely placed at `top` in its host. */
export default function LanguageDownloadNotice({ code, top }: { readonly code: string | null; readonly top: number }) {
    const reduceMotion = useReducedMotion();
    if (!code) return null;
    // The notice speaks the language being fetched: the reader picked it, and
    // iOS dims the rest of the screen while it asks.
    const lt = i18n.getFixedT(code);
    const dir = RTL_CODES.has(code) ? 'rtl' : 'ltr';
    const title = lt('auth.track.gettingReadyTitle', { language: getNativeLanguageName(code) ?? code });
    const body = lt('auth.track.gettingReadyIos');
    return (
        <Animated.View
            key={code}
            entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(220)}
            exiting={FadeOut.duration(220)}
            accessibilityLiveRegion="polite"
            // The LIGHT modal material with dark ink in BOTH themes: iOS's
            // download sheet dims everything behind it, and this card has to
            // read through that. A hairline edge keeps it apart from a light page.
            style={[styles.message, { top }]}
            testID="auth-language-message-getting"
        >
            <ModalMaterial scheme="light" />
            <DownloadPressIllustration />
            <View style={styles.messageText}>
                <Text style={[styles.messageTitle, { color: NOTICE_INK, writingDirection: dir }]}>{title}</Text>
                <Text style={[styles.messageBody, { color: NOTICE_INK, writingDirection: dir }]}>
                    {/* The ↓ stands for iOS's download button: the illustration's
                        blue, one shade deeper so it reads through the sheet's dim. */}
                    {body.split('↓').map((part, i) =>
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
    );
}

const styles = StyleSheet.create({
    message: {
        position: 'absolute',
        left: 16,
        right: 16,
        zIndex: 2,
        elevation: 2,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 20,
        borderRadius: 20,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: COLORS.light.line,
        overflow: 'hidden',
    },
    messageText: { flex: 1, gap: 6 },
    messageTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
    messageBody: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
    downArrow: { color: COLORS.light.infoStrong, fontWeight: '800' },
});
