import { FeedbackWidget } from '@sentry/react-native';
import * as Sentry from '@sentry/react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import React, { useEffect } from 'react';
import {
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    View,
    useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MeraLogo from '@/components/custom/MeraLogo';
import { authClient } from '@/lib/auth-client';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useFeedbackStore, useFeedbackVisible } from '@/lib/stores/feedback-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';

// Diagnostic context attached to each feedback submission. captureFeedback
// applies the current scope's contexts/tags, and beforeSend (lib/sentry-init.ts)
// only runs on ERROR events, so this rides along on the feedback. Deliberately
// app-state only — NOTHING from the user facts table (or any personal content).
function attachFeedbackMetadata(userId: string | undefined): void {
    // Use the app's user id as the feedback identifier (id only — no email/ip/
    // username, which the error-path scrubber strips anyway).
    if (userId) {
        Sentry.setUser({ id: userId });
    }

    // Non-reactive reads — this runs on open, not on every store change.
    const { appLanguage, showOriginal } = useAppLanguageStore.getState();
    const { tier, isPremium } = useSubscriptionStore.getState();
    const { processingMode, modelState } = useMeraProtocolStore.getState();

    Sentry.setContext('mera_app_state', {
        appVersion: Application.nativeApplicationVersion,
        buildVersion: Application.nativeBuildVersion,
        otaUpdateId: Updates.updateId,
        otaChannel: Updates.channel,
        runtimeVersion: Updates.runtimeVersion,
        isEmbeddedLaunch: Updates.isEmbeddedLaunch,
        platform: Platform.OS,
        platformVersion: String(Platform.Version),
        appLanguage,
        showOriginal,
        subscriptionTier: tier ?? 'free',
        isPremium,
        processingMode,
        modelState,
    });

    // Indexed tags for filtering feedback in Sentry.
    Sentry.setTag('app_version', Application.nativeApplicationVersion ?? 'unknown');
    Sentry.setTag('ota_channel', Updates.channel ?? 'embedded');
    Sentry.setTag('subscription_tier', tier ?? 'free');
    Sentry.setTag('processing_mode', processingMode);
    Sentry.setTag('app_language', appLanguage);
}

// Floating-card chrome: dark rounded panel over a dimmed backdrop, no outline.
// Deliberately dark-locked in both app themes — the Sentry FeedbackWidget's
// theme is pinned to 'dark' in lib/sentry-init.ts (init runs pre-React, so it
// can't follow the in-app theme store) and the white Mera logo needs a dark
// surface. The Mera-orange accent lives on the widget's submit button (set via
// the feedbackIntegration theme in lib/sentry-init.ts).
const PANEL_BG = '#1E1E24';
const CLOSE_RED = '#ef4444'; // error-400, same close affordance as ChatPopover

/**
 * The "Report a Bug" form. Renders Sentry's `FeedbackWidget` component (which
 * submits via Sentry.captureFeedback) inside a bounded, centered floating card
 * so it never runs off-screen — the widget's own root is `flex: 1` with no
 * scroll, which overflowed the bottom when hosted full-screen. Here the card is
 * height-capped and the form scrolls inside it, with our own Mera-branded header
 * (logo + top-right close, like the chat bubble) instead of Sentry branding and
 * a bottom Cancel button.
 *
 * We localize every label (unlike Sentry.showFeedbackWidget(), whose labels are
 * frozen in English at Sentry.init()). Opened via showFeedback()
 * (lib/feedback.ts) from the Preferences "Report a Bug" row. Mounted app-wide in
 * app/logged-in/_layout.tsx so it presents over any screen (it's a native Modal).
 * Theme (dark + Mera-orange accent) is read by FeedbackWidget from the
 * feedbackIntegration config in lib/sentry-init.ts.
 */
const FeedbackWidgetModal: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { height: screenHeight } = useWindowDimensions();
    const visible = useFeedbackVisible();
    const hide = useFeedbackStore((s) => s.hide);

    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;
    const userEmail = session?.user?.email;

    // On open, set the feedback identifier (user id) + diagnostic metadata so it's
    // on the scope before the user submits. See attachFeedbackMetadata for why
    // this is safe wrt the no-PII / no-user-facts invariants.
    useEffect(() => {
        if (!SENTRY_ENABLED || !visible) {
            return;
        }
        attachFeedbackMetadata(userId);
    }, [visible, userId]);

    // captureFeedback no-ops without Sentry.init, so there's nothing to show.
    if (!SENTRY_ENABLED || !visible) {
        return null;
    }

    // Cap the card so it floats within the safe area with the backdrop peeking at
    // every edge, rather than filling the screen.
    const maxCardHeight = screenHeight - insets.top - insets.bottom - 48;

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={hide} statusBarTranslucent>
            <KeyboardAvoidingView
                style={styles.root}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                {/* Backdrop — tap outside the card to close. */}
                <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={hide}
                    accessibilityLabel={t('feedback.cancelButtonLabel')}
                    accessibilityRole="button"
                />

                <View style={[styles.card, { maxHeight: maxCardHeight }]}>
                    {/* Mera-branded header: logo left, close X top-right (chat-bubble
                        pattern) — replaces the Sentry logo + bottom Cancel button. */}
                    <View style={styles.header}>
                        <MeraLogo size={30} />
                        <Pressable
                            onPress={hide}
                            accessibilityLabel={t('feedback.cancelButtonLabel')}
                            accessibilityRole="button"
                            hitSlop={12}
                            style={styles.closeButton}
                        >
                            <MaterialIcons name="close" size={22} color="#fff" />
                        </Pressable>
                    </View>

                    <ScrollView
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator
                        contentContainerStyle={styles.scrollContent}
                        bounces={false}
                    >
                        <FeedbackWidget
                            // Message-only form: no name field, email prefilled from
                            // the signed-in session (still editable), on-device
                            // screenshot capture only. Sentry branding hidden — our
                            // header carries the Mera logo instead.
                            showName={false}
                            showEmail
                            isEmailRequired={false}
                            showBranding={false}
                            enableTakeScreenshot
                            useSentryUser={{ email: userEmail ?? '', name: '' }}
                            // Drop the widget's own `flex: 1` (it would collapse to
                            // zero height inside a ScrollView), make it transparent so
                            // the card supplies the background, and hide the built-in
                            // Cancel button (the header X closes instead).
                            styles={{
                                container: styles.widgetContainer,
                                cancelButton: styles.hiddenCancel,
                            }}
                            // Localized labels.
                            formTitle={t('feedback.formTitle')}
                            submitButtonLabel={t('feedback.submitButtonLabel')}
                            cancelButtonLabel={t('feedback.cancelButtonLabel')}
                            emailLabel={t('feedback.emailLabel')}
                            emailPlaceholder={t('feedback.emailPlaceholder')}
                            messageLabel={t('feedback.messageLabel')}
                            messagePlaceholder={t('feedback.messagePlaceholder')}
                            isRequiredLabel={t('feedback.isRequiredLabel')}
                            successMessageText={t('feedback.successMessageText')}
                            addScreenshotButtonLabel={t('feedback.addScreenshotButtonLabel')}
                            removeScreenshotButtonLabel={t('feedback.removeScreenshotButtonLabel')}
                            captureScreenshotButtonLabel={t('feedback.captureScreenshotButtonLabel')}
                            errorTitle={t('feedback.errorTitle')}
                            formError={t('feedback.formError')}
                            emailError={t('feedback.emailError')}
                            captureScreenshotError={t('feedback.captureScreenshotError')}
                            genericError={t('feedback.genericError')}
                            onFormClose={hide}
                            onFormSubmitted={hide}
                        />
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    root: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    card: {
        width: '100%',
        maxWidth: 480,
        borderRadius: 24,
        backgroundColor: PANEL_BG,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 2,
    },
    closeButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: CLOSE_RED,
        justifyContent: 'center',
        alignItems: 'center',
    },
    scrollContent: {
        flexGrow: 1,
    },
    // Override for the widget's root View: no flex (so it sizes to content inside
    // the ScrollView) and transparent so the card's background shows through.
    // Reduced top padding since our header sits above.
    widgetContainer: {
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 20,
        backgroundColor: 'transparent',
    },
    // The built-in Cancel button is replaced by the header X.
    hiddenCancel: {
        display: 'none',
    },
});

export default FeedbackWidgetModal;
