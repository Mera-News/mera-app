import { FeedbackWidget } from '@sentry/react-native';
import * as Sentry from '@sentry/react-native';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import {
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MeraLogo from '@/components/custom/MeraLogo';
import ModalMaterial from '@/components/custom/ModalMaterial';
import { authClient } from '@/lib/auth-client';
import { emailLooksAnonymous } from '@/lib/subscription/email-capture';
import { readSupportIdFromUser } from '@/lib/support-id';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useFeedbackStore, useFeedbackVisible } from '@/lib/stores/feedback-store';
import { useUserStore } from '@/lib/stores/user-store';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { useMotionAllowed } from '@/lib/motion-gate';

// Set the feedback identifier so a submitted report can be tied back to the
// account that filed it. captureFeedback applies the current scope's user.
//
// This function used to ALSO set `mera_app_state` and five tags (app_version,
// ota_channel, subscription_tier, processing_mode, app_language) — on the GLOBAL
// scope, from a modal, so they were never removed. beforeSend only touched
// event.user, never event.tags or event.contexts, which meant that once a user
// opened "Report a Bug", every subsequent error that session carried their
// subscription tier and app state. That enrichment is now applied globally,
// deliberately and from one place (lib/observability/sentry-scope.ts), for every
// session — so setting it again here bought nothing and leaked by accident.
// Do not re-add per-surface scope writes.
function attachFeedbackMetadata(userId: string | undefined, supportId: string | null): void {
    // Id only — no email/ip/username. lib/sentry-init.ts documents the contract.
    // support_id is the 8-digit support handle, minted to be the NON-PII lookup
    // key, so it rides the feedback payload for the same reason the email does
    // not. Conditional: absent stays absent.
    if (userId) {
        Sentry.setUser({ id: userId, ...(supportId ? { support_id: supportId } : {}) });
    }
}

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
    // Lite / Reduce Motion: the modal appears at once (lib/motion-gate.ts).
    const motion = useMotionAllowed();
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const styles = useStyles();
    const c = useColors();
    const visible = useFeedbackVisible();
    const hide = useFeedbackStore((s) => s.hide);

    // Local-first, same rule as Settings (config-mera/AppPreferencesTab) and the
    // launch gate. A bug report is most likely to be filed when something is
    // wrong — which is exactly when /get-session is least likely to answer — and
    // reading identity off the session meant those reports arrived with no
    // Sentry user id and an empty email box, the ones we can least afford to
    // lose. The persisted values survive a session we cannot reach; the session
    // stays as the fallback for installs that pre-date the cached_user_email row.
    const { data: session } = authClient.useSession();
    const localUserId = useUserStore((s) => s.userId);
    const localUserEmail = useUserStore((s) => s.userEmail);
    const userId = localUserId ?? session?.user?.id;
    // The fabricated @anon.mera.news address must never be shown or prefilled
    // as if it were the user's — an anonymous account simply has no email here.
    const sessionEmail = session?.user?.email;
    const userEmail =
        localUserEmail ?? (sessionEmail && !emailLooksAnonymous(sessionEmail) ? sessionEmail : undefined);
    // The support handle rides the feedback payload so a report from an
    // anonymous account is traceable without an email.
    const supportId = readSupportIdFromUser(session?.user);

    // On open, set the feedback identifier so it's on the scope before the user
    // submits. The diagnostic tags/context that used to be set here now come
    // from the global scope — see attachFeedbackMetadata.
    useEffect(() => {
        if (!SENTRY_ENABLED || !visible) {
            return;
        }
        attachFeedbackMetadata(userId, supportId);
    }, [visible, userId, supportId]);

    // captureFeedback no-ops without Sentry.init, so there's nothing to show.
    if (!SENTRY_ENABLED || !visible) {
        return null;
    }

    return (
        <Modal visible={visible} transparent animationType={motion ? 'fade' : 'none'} onRequestClose={hide} statusBarTranslucent>
            {/* The app's centred dialog (HelpModal / ConfirmDialog): the card is
                capped at the room inside the safe area and above the keyboard,
                and the form scrolls inside it. */}
            <KeyboardAvoidingView
                style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                {/* Backdrop — tap outside the card to close. */}
                <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={hide}
                    accessibilityLabel={t('feedback.cancelButtonLabel')}
                    accessibilityRole="button"
                />

                <View style={styles.card} accessibilityViewIsModal>
                    <ModalMaterial />
                    {/* The dialog header: the Mera mark and the form's title, and the
                        standard close X (it replaces the widget's own title and its
                        bottom Cancel). */}
                    <View style={styles.header}>
                        <View style={styles.headerTitle}>
                            <MeraLogo size={30} />
                            <Text accessibilityRole="header" style={styles.title}>
                                {t('feedback.formTitle')}
                            </Text>
                        </View>
                        <Pressable
                            onPress={hide}
                            accessibilityLabel={t('feedback.cancelButtonLabel')}
                            accessibilityRole="button"
                            style={styles.close}
                        >
                            <MaterialIcons name="close" size={22} color={c.ink2} />
                        </Pressable>
                    </View>

                    <ScrollView
                        style={styles.scroll}
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
                            // The widget's theme is fixed dark (lib/sentry-init.ts), so
                            // every part the reader sees is restyled on the app's
                            // tokens here; the widget REPLACES a style it is given,
                            // so each is complete.
                            styles={{
                                container: styles.widgetContainer,
                                titleContainer: styles.hidden,
                                cancelButton: styles.hidden,
                                label: styles.label,
                                input: styles.input,
                                textArea: styles.textArea,
                                screenshotButton: styles.outlineButton,
                                takeScreenshotButton: styles.takeScreenshotButton,
                                screenshotText: styles.outlineText,
                                takeScreenshotText: styles.outlineText,
                                submitButton: styles.submitButton,
                                submitText: styles.submitText,
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

const CLOSE_FRAME = 44;

const useStyles = themedStyles((c) => StyleSheet.create({
    root: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: c.scrim,
    },
    // The dialog surface (HelpModal): 16pt corners, a 1pt edge, the material
    // behind, at most 400 wide and never taller than the room it has.
    card: {
        width: '100%',
        maxWidth: 400,
        maxHeight: '100%',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: c.line,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 16,
        paddingLeft: 24,
        paddingRight: 8,
        gap: 8,
    },
    headerTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
    title: { flex: 1, color: c.ink, fontSize: 20, lineHeight: 26, fontWeight: '700' },
    close: { width: CLOSE_FRAME, height: CLOSE_FRAME, alignItems: 'center', justifyContent: 'center' },
    scroll: { flexGrow: 0, flexShrink: 1 },
    scrollContent: { flexGrow: 1 },
    // The widget's root: no flex (it would collapse inside the ScrollView),
    // transparent so the material shows, the dialog's 24pt padding.
    widgetContainer: {
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 24,
        backgroundColor: 'transparent',
    },
    hidden: { display: 'none' },
    label: { marginBottom: 6, fontSize: 15, color: c.ink2 },
    input: {
        minHeight: 48,
        borderColor: c.trackBorder,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        marginBottom: 16,
        fontSize: 16,
        color: c.ink,
        backgroundColor: c.surface,
    },
    textArea: { height: 110, paddingTop: 12, textAlignVertical: 'top', color: c.ink },
    // The outlined secondary of ConfirmDialog.
    outlineButton: {
        flex: 1,
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.edge,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
    },
    takeScreenshotButton: {
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.edge,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        marginTop: -4,
        marginBottom: 16,
    },
    outlineText: { color: c.ink, fontSize: 15, fontWeight: '600' },
    // The primary of ConfirmDialog: the accent pill at 44pt.
    submitButton: {
        minHeight: 44,
        borderRadius: 999,
        backgroundColor: c.accent,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
    },
    submitText: { color: c.onAccent, fontSize: 16, fontWeight: '600' },
}));

export default FeedbackWidgetModal;
