import { useRestartHold } from '@/lib/app-restart';
import { FeedbackWidget } from '@sentry/react-native';
import * as Sentry from '@sentry/react-native';
import React, { useEffect, useRef } from 'react';
import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
    useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import MeraLogo from '@/components/custom/MeraLogo';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { finishPrefilledReport } from '@/lib/feedback';
import { authClient } from '@/lib/auth-client';
import { readSupportIdFromUser } from '@/lib/support-id';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useFeedbackStore, useFeedbackVisible } from '@/lib/stores/feedback-store';
import { useUserStore } from '@/lib/stores/user-store';
import { themedStyles } from '@/lib/theme/tokens';

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
 * The "Report a bug" form: Sentry's `FeedbackWidget` (which submits via
 * Sentry.captureFeedback) in the app's one BottomSheet, with our own header (the
 * Mera mark and the localized title) and a 48pt Cancel plate. The message is the
 * only field: no email, no name. The widget's own `flex: 1` root is neutralised
 * so the form scrolls inside the sheet instead of running off-screen.
 *
 * We localize every label (unlike Sentry.showFeedbackWidget(), whose labels are
 * frozen in English at Sentry.init()). Opened via showFeedback()
 * (lib/feedback.ts). Mounted app-wide in app/logged-in/_layout.tsx. The widget is
 * in the tree only while the sheet is open or closing: its unmount is what saves
 * the draft, and a prefilled report that was not sent is wiped right after it
 * (finishPrefilledReport). Theme (dark + Mera-orange accent) is read by
 * FeedbackWidget from the feedbackIntegration config in lib/sentry-init.ts, so
 * every part is restyled on the app's tokens through `styles`.
 */
const FeedbackWidgetModal: React.FC = () => {
    const { t } = useTranslation();
    const { height: windowHeight } = useWindowDimensions();
    const styles = useStyles();
    const visible = useFeedbackVisible();
    const mounted = useFeedbackStore((s) => s.mounted);
    const hide = useFeedbackStore((s) => s.hide);
    const unmount = useFeedbackStore((s) => s.unmount);
    const sent = useRef(false);
    useRestartHold(visible, 'overlay:feedback', 'auto');
    // The Sentry widget owns its text fields and exposes no change event, so the draft hold spans the open form.
    useRestartHold(visible, 'draft:feedback', 'hard');

    // Local-first identity (the session is unreachable exactly when a bug is filed).
    const { data: session } = authClient.useSession();
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;
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
        sent.current = false;
        attachFeedbackMetadata(userId, supportId);
    }, [visible, userId, supportId]);

    // Runs after the commit that unmounted the widget, whose unmount saved the draft.
    useEffect(() => {
        if (!mounted) finishPrefilledReport(sent.current);
    }, [mounted]);

    // captureFeedback no-ops without Sentry.init, so there's nothing to show.
    if (!SENTRY_ENABLED || !mounted) {
        return null;
    }

    return (
        // `avoidKeyboard` lifts the whole sheet above the iOS keyboard; a
        // KeyboardAvoidingView inside the sheet never moved the sheet itself.
        <BottomSheet
            open={visible}
            onClose={hide}
            onClosed={unmount}
            avoidKeyboard
            testID="feedback-sheet"
            scrimLabel={t('feedback.cancelButtonLabel')}
        >
            <View>
                <View style={styles.header}>
                    <MeraLogo size={30} />
                    <Text accessibilityRole="header" style={styles.title}>
                        {t('feedback.formTitle')}
                    </Text>
                </View>

                <ScrollView
                    style={{ maxHeight: windowHeight * 0.55 }}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator
                    bounces={false}
                >
                    <FeedbackWidget
                        // Message-only form: no name, no email, on-device
                        // screenshot capture only. Sentry branding hidden: our
                        // header carries the Mera logo instead.
                        showName={false}
                        showEmail={false}
                        showBranding={false}
                        enableTakeScreenshot
                        useSentryUser={{ email: '', name: '' }}
                        // The widget REPLACES a style it is given, so each is
                        // complete; its own flex: 1 root is dropped (it would
                        // collapse inside a ScrollView), and its title and Cancel
                        // are hidden (the header and the plate below replace them).
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
                        messageLabel={t('feedback.messageLabel')}
                        messagePlaceholder={t('feedback.messagePlaceholder')}
                        isRequiredLabel={t('feedback.isRequiredLabel')}
                        successMessageText={t('feedback.successMessageText')}
                        addScreenshotButtonLabel={t('feedback.addScreenshotButtonLabel')}
                        removeScreenshotButtonLabel={t('feedback.removeScreenshotButtonLabel')}
                        captureScreenshotButtonLabel={t('feedback.captureScreenshotButtonLabel')}
                        errorTitle={t('feedback.errorTitle')}
                        formError={t('feedback.formError')}
                        captureScreenshotError={t('feedback.captureScreenshotError')}
                        genericError={t('feedback.genericError')}
                        onFormClose={hide}
                        onFormSubmitted={() => {
                            sent.current = true;
                            hide();
                        }}
                    />
                </ScrollView>

                <Pressable
                    testID="feedback-cancel"
                    onPress={hide}
                    accessibilityLabel={t('feedback.cancelButtonLabel')}
                    accessibilityRole="button"
                >
                    {/* Layout on an inner View: a function style on a Pressable is dropped on device. */}
                    <View style={styles.cancelPlate}>
                        <Text style={styles.cancelText}>{t('feedback.cancelButtonLabel')}</Text>
                    </View>
                </Pressable>
            </View>
        </BottomSheet>
    );
};

const useStyles = themedStyles((c) => StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 },
    title: { flex: 1, color: c.ink, fontSize: 20, lineHeight: 26, fontWeight: '700' },
    cancelPlate: {
        minHeight: 48,
        marginTop: 8,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceRaised,
    },
    cancelText: { color: c.ink, fontSize: 15, fontWeight: '600', textAlign: 'center' },
    // The widget's root: no flex (it would collapse inside the ScrollView),
    // transparent so the material shows, the dialog's 24pt padding.
    widgetContainer: {
        paddingTop: 12,
        paddingBottom: 12,
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
