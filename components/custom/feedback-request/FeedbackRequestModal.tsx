// FeedbackRequestModal: one question from the Mera team, a text area and a
// submit button, on the app's centred dialog (HelpModal / ConfirmDialog).
//
// WHY A ROUTE (app/logged-in/feedback-request.tsx, `transparentModal`) and not
// an in-tree RN Modal like every other sheet in the app: a push tap can only
// open a ROUTE. NotificationHref, the stash, the PIN lock and the startup gate
// (lib/stores/pending-notification-route.ts) are all route-based, so one route
// serves all three entry points: the push tap, the drawer row and the
// auto-show host.
//
// Every presentation stamps shownAt on mount, whatever opened it, so a
// question opened from a push or the drawer never pops up again later. Every
// close without an answer stamps dismissedAt. Both stay on the device.
//
// CONSENT FIRST. The answer goes to the server with the account id and tier,
// and on iOS this transparentModal presents natively ABOVE the in-tree
// ConsentGate. So the route checks consent itself (the same guard the
// auto-show host uses, feedback-request-consent.ts) before the card mounts:
// while it is unresolved or not accepted there is no card, and a "not
// accepted" answer closes the route. Nothing is stamped on that path (the card
// never mounted), so the question is offered again once consent is accepted
// and the drawer row still opens it.
//
// Closed is decided twice: locally from endsAt, and from the server's
// FEEDBACK_REQUEST_CLOSED on submit. An id this device has never synced (a
// push tap before the first sync) is fetched once; absent from the active
// list means closed.

import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MeraLogo from '@/components/custom/MeraLogo';
import ModalMaterial from '@/components/custom/ModalMaterial';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { markActionedBySource } from '@/lib/database/services/notification-service';
import {
    FEEDBACK_RESPONSE_MAX_CHARS,
    fetchActiveFeedbackRequests,
    submitFeedbackResponse,
} from '@/lib/feedback-requests/feedback-request-service';
import {
    isFeedbackRequestEnded,
    markFeedbackRequestAnswered,
    markFeedbackRequestDismissed,
    markFeedbackRequestShown,
    readFeedbackRequestsState,
} from '@/lib/feedback-requests/feedback-request-state';
import {
    feedbackRequestNotificationSource,
    ingestFeedbackRequests,
} from '@/lib/feedback-requests/feedback-request-sync';
import type { ConsentSessionUser } from '@/components/custom/auth/legal-consent';
import { authClient } from '@/lib/auth-client';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { isFeedbackRequestId } from '@/lib/stores/pending-notification-route';
import { useUserStore } from '@/lib/stores/user-store';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { consentBlocksFeedbackRequest } from './feedback-request-consent';

/** The counter appears once the answer is this close to the limit. */
const COUNTER_FROM = FEEDBACK_RESPONSE_MAX_CHARS - 200;

type Phase =
    | { kind: 'loading' }
    | { kind: 'load-error'; offline: boolean }
    | { kind: 'open' }
    | { kind: 'submitting' }
    | { kind: 'error'; offline: boolean }
    | { kind: 'thanks' }
    | { kind: 'already' }
    | { kind: 'closed' };

export interface FeedbackRequestModalProps {
    /** The route's `id` param, unvalidated. */
    readonly id: string | undefined;
    readonly onClose: () => void;
}

type ConsentPhase = 'checking' | 'clear' | 'blocked';

const FeedbackRequestModal: React.FC<FeedbackRequestModalProps> = ({ id, onClose }) => {
    const { data: session, isPending } = authClient.useSession();
    // Local first, session as fallback: offline the session may not resolve,
    // and the persisted id is still the signed-in account.
    const localUserId = useUserStore((s) => s.userId);
    const userId = session?.user?.id ?? localUserId ?? null;
    const styles = useStyles();
    const sessionUser = session?.user as ConsentSessionUser | undefined;
    const [consent, setConsent] = useState<ConsentPhase>('checking');

    useEffect(() => {
        if (isPending) return;
        if (!userId) {
            setConsent('blocked');
            return;
        }
        let cancelled = false;
        consentBlocksFeedbackRequest(userId, sessionUser)
            .then((blocked) => {
                if (!cancelled) setConsent(blocked ? 'blocked' : 'clear');
            })
            // Fails open, like ConsentGate: an unanswerable check never blocks.
            .catch(() => {
                if (!cancelled) setConsent('clear');
            });
        return () => {
            cancelled = true;
        };
        // sessionUser is read at check time; the id is what identifies it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPending, userId]);

    const closedForConsent = useRef(false);
    useEffect(() => {
        if (consent !== 'blocked' || closedForConsent.current) return;
        closedForConsent.current = true;
        onClose();
    }, [consent, onClose]);

    if (consent !== 'clear') {
        // No card: the dim backdrop alone, for the moment the check takes.
        return <View testID="feedback-request-consent-wait" style={styles.root} />;
    }
    return <FeedbackRequestCard id={id} onClose={onClose} />;
};

const FeedbackRequestCard: React.FC<FeedbackRequestModalProps> = ({ id, onClose }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const styles = useStyles();
    const c = useColors();
    const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
    const [question, setQuestion] = useState<string | null>(null);
    const [answer, setAnswer] = useState('');
    const endsAtRef = useRef<number | null>(null);
    /** True once there is nothing left to skip (answered or closed). */
    const settledRef = useRef(false);

    const validId = isFeedbackRequestId(id) ? id : null;

    const load = useCallback(async () => {
        if (!validId) {
            settledRef.current = true;
            setPhase({ kind: 'closed' });
            return;
        }
        setPhase({ kind: 'loading' });
        const state = await readFeedbackRequestsState();
        let entry = state[validId];
        if (!entry) {
            const result = await fetchActiveFeedbackRequests(useAppLanguageStore.getState().appLanguage);
            if (!result.ok) {
                setPhase({ kind: 'load-error', offline: result.offline });
                return;
            }
            // Same local record the sync task would leave, drawer row included.
            await ingestFeedbackRequests(result.requests);
            const found = result.requests.find((r) => r.id === validId);
            if (!found) {
                settledRef.current = true;
                setPhase({ kind: 'closed' });
                return;
            }
            entry = { question: found.question, endsAt: found.endsAt };
            if (found.answered) entry.answeredAt = Date.now();
        }
        setQuestion(entry.question);
        endsAtRef.current = entry.endsAt;
        await markFeedbackRequestShown(validId, Date.now(), entry);
        if (entry.answeredAt !== undefined) {
            settledRef.current = true;
            setPhase({ kind: 'already' });
        } else if (isFeedbackRequestEnded(entry)) {
            settledRef.current = true;
            setPhase({ kind: 'closed' });
        } else {
            setPhase({ kind: 'open' });
        }
    }, [validId]);

    useEffect(() => {
        load().catch((err: unknown) => {
            logger.captureException(err, {
                tags: { component: 'FeedbackRequestModal', method: 'load' },
            });
            setPhase({ kind: 'load-error', offline: false });
        });
    }, [load]);

    // Any close without an answer is a skip, however it happened (the X, the
    // backdrop, the Android back button, a navigation away).
    useEffect(() => {
        return () => {
            if (validId && !settledRef.current) void markFeedbackRequestDismissed(validId);
        };
    }, [validId]);

    const handleSubmit = useCallback(async () => {
        if (!validId) return;
        const text = answer.trim();
        if (!text) return;
        if (endsAtRef.current !== null && isFeedbackRequestEnded({ endsAt: endsAtRef.current })) {
            settledRef.current = true;
            setPhase({ kind: 'closed' });
            return;
        }
        void hapticLight();
        setPhase({ kind: 'submitting' });
        const outcome = await submitFeedbackResponse(validId, text);
        if (outcome.status === 'closed') {
            settledRef.current = true;
            setPhase({ kind: 'closed' });
            return;
        }
        if (outcome.status === 'error') {
            setPhase({ kind: 'error', offline: outcome.offline });
            return;
        }
        settledRef.current = true;
        setPhase({ kind: outcome.alreadyAnswered ? 'already' : 'thanks' });
        try {
            await markFeedbackRequestAnswered(validId);
            await markActionedBySource(feedbackRequestNotificationSource(validId));
        } catch (err) {
            logger.captureException(err, {
                tags: { component: 'FeedbackRequestModal', method: 'markAnswered' },
            });
        }
    }, [answer, validId]);

    const showsTextArea =
        phase.kind === 'open' || phase.kind === 'submitting' || phase.kind === 'error';
    const submitting = phase.kind === 'submitting';
    const canSubmit = showsTextArea && !submitting && answer.trim().length > 0;
    // A backdrop tap with text typed would throw the answer away.
    const backdropCloses = !showsTextArea || answer.trim().length === 0;

    let message: string | null = null;
    if (phase.kind === 'thanks') message = t('feedbackRequest.thanks');
    else if (phase.kind === 'already') message = t('feedbackRequest.alreadyAnswered');
    else if (phase.kind === 'closed') message = t('feedbackRequest.closed');
    else if (phase.kind === 'load-error') message = phase.offline ? t('feedbackRequest.offline') : t('feedbackRequest.loadError');

    const actionButton = (testID: string, label: string, onPress: () => void) => (
        <Button action="primary" onPress={onPress} style={styles.button} testID={testID}>
            <ButtonText>{label}</ButtonText>
        </Button>
    );

    // The app's centred dialog (HelpModal / ConfirmDialog): the modal material
    // filling the whole card, 16pt corners, a 1pt edge, the title row, a close
    // X in ink. The submit button sits in a footer OUTSIDE the scroll, so with
    // the keyboard up the body scrolls and the button stays on screen.
    return (
        <KeyboardAvoidingView
            style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <Pressable
                style={StyleSheet.absoluteFill}
                onPress={backdropCloses ? onClose : undefined}
                accessible={false}
                importantForAccessibility="no"
            />
            <View testID="feedback-request-card" accessibilityViewIsModal style={styles.card}>
                <ModalMaterial />
                <View style={styles.header}>
                    <View style={styles.headerTitle}>
                        <MeraLogo size={30} />
                        <Text accessibilityRole="header" style={styles.title}>
                            {t('feedbackRequest.title')}
                        </Text>
                    </View>
                    <Pressable
                        testID="feedback-request-close"
                        onPress={onClose}
                        accessibilityLabel={t('feedbackRequest.close')}
                        accessibilityRole="button"
                        style={styles.close}
                    >
                        <MaterialIcons name="close" size={22} color={c.ink2} />
                    </Pressable>
                </View>

                <ScrollView
                    style={styles.scroll}
                    keyboardShouldPersistTaps="handled"
                    bounces={false}
                    contentContainerStyle={styles.body}
                >
                    {phase.kind === 'loading' ? (
                        <ActivityIndicator
                            testID="feedback-request-loading"
                            color={c.accentMark}
                            style={styles.spinner}
                            accessibilityLabel={t('common.loading')}
                        />
                    ) : null}

                    {question && phase.kind !== 'loading' && phase.kind !== 'load-error' ? (
                        <Text testID="feedback-request-question" style={styles.question}>
                            {question}
                        </Text>
                    ) : null}

                    {showsTextArea ? (
                        <>
                            <Input className="min-h-32 h-auto items-start rounded-xl mt-4">
                                <InputField
                                    testID="feedback-request-input"
                                    accessibilityLabel={t('feedbackRequest.answerLabel')}
                                    placeholder={t('feedbackRequest.placeholder')}
                                    value={answer}
                                    onChangeText={setAnswer}
                                    multiline
                                    numberOfLines={5}
                                    textAlignVertical="top"
                                    maxLength={FEEDBACK_RESPONSE_MAX_CHARS}
                                    editable={!submitting}
                                    className="py-3 text-ink"
                                />
                            </Input>
                            {answer.length >= COUNTER_FROM ? (
                                <Text testID="feedback-request-counter" size="xs" style={styles.counter}>
                                    {t('feedbackRequest.counter', {
                                        current: answer.length,
                                        max: FEEDBACK_RESPONSE_MAX_CHARS,
                                    })}
                                </Text>
                            ) : null}
                            {phase.kind === 'error' ? (
                                <Text testID="feedback-request-error" size="sm" style={styles.error}>
                                    {phase.offline ? t('feedbackRequest.offline') : t('feedbackRequest.error')}
                                </Text>
                            ) : null}
                            {/* What leaves the device with the answer, said
                                before the button that sends it. */}
                            <Text testID="feedback-request-disclaimer" size="xs" style={styles.disclaimer}>
                                {t('feedbackRequest.disclaimer')}
                            </Text>
                        </>
                    ) : null}

                    {message ? (
                        <Text
                            testID={`feedback-request-${phase.kind}`}
                            style={styles.message}
                            accessibilityLiveRegion="polite"
                        >
                            {message}
                        </Text>
                    ) : null}
                </ScrollView>

                {showsTextArea ? (
                    <View style={styles.footer}>
                        {/* The app's primary: the accent, and the standard
                            disabled look while the answer is empty. */}
                        <Button
                            action="primary"
                            onPress={() => void handleSubmit()}
                            isDisabled={!canSubmit}
                            accessibilityLabel={t('feedbackRequest.submit')}
                            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
                            style={styles.button}
                            testID="feedback-request-submit"
                        >
                            {submitting ? <ButtonSpinner /> : null}
                            <ButtonText>{t('feedbackRequest.submit')}</ButtonText>
                        </Button>
                    </View>
                ) : null}
                {phase.kind === 'load-error' ? (
                    <View style={styles.footer}>
                        {actionButton('feedback-request-retry', t('feedbackRequest.retry'), () => void load())}
                    </View>
                ) : null}
                {phase.kind === 'thanks' || phase.kind === 'already' || phase.kind === 'closed' ? (
                    <View style={styles.footer}>
                        {actionButton('feedback-request-done', t('feedbackRequest.close'), onClose)}
                    </View>
                ) : null}
            </View>
        </KeyboardAvoidingView>
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
    // behind; it never grows past the room left above the keyboard.
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
    headerTitle: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    title: { flex: 1, color: c.ink, fontSize: 20, lineHeight: 26, fontWeight: '700' },
    close: { width: CLOSE_FRAME, height: CLOSE_FRAME, alignItems: 'center', justifyContent: 'center' },
    scroll: { flexGrow: 0, flexShrink: 1 },
    body: {
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 8,
    },
    spinner: {
        marginVertical: 24,
    },
    question: { color: c.ink, fontSize: 17, lineHeight: 24 },
    counter: {
        color: c.ink2,
        textAlign: 'right',
        marginTop: 6,
    },
    error: { color: c.negative, marginTop: 12 },
    disclaimer: {
        color: c.ink2,
        marginTop: 12,
        lineHeight: 18,
    },
    message: {
        color: c.ink2,
        fontSize: 16,
        lineHeight: 22,
        marginTop: 4,
    },
    footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 },
    // 44pt, as ConfirmDialog (the Modals board).
    button: { minHeight: 44 },
}));

export default FeedbackRequestModal;
