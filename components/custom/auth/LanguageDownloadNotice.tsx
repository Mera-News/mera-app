// The ONE language download notice (FinalJourney #10), shown by first launch
// and by Settings > Language: "Getting <language> ready" on the LIGHT modal
// material with the pressing-↓ illustration, in the language being fetched.
//
// When it shows is `useLanguageDownloadNotice` (use-language-download-notice.ts).

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, useReducedMotion } from 'react-native-reanimated';

import DownloadPressIllustration from '@/components/custom/auth/DownloadPressIllustration';
import ModalMaterial from '@/components/custom/ModalMaterial';
import i18n from '@/lib/i18n';
import { COLORS } from '@/lib/theme/tokens';
import { getNativeLanguageName } from '@/lib/translation-service';

export { useLanguageDownloadNotice } from './use-language-download-notice';

const RTL_CODES = new Set(['ar', 'he']);
/** The notice wears the light theme's modal material and ink in both themes. */
const NOTICE_INK = COLORS.light.ink;

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
