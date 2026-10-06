import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
// FeedbackRequestModal: one question from the Mera team, a text area and a
// submit button, on a centred glass card (the FeedbackWidgetModal look).
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
    useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TranslucentPlate } from '@/components/custom/GlassSurface';
import MeraLogo from '@/components/custom/MeraLogo';
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
import { consentBlocksFeedbackRequest } from './feedback-request-consent';

const ACCENT = '#EDA77E';
const CLOSE_RED = '#ef4444'; // same close affordance as FeedbackWidgetModal
const SECONDARY = 'rgb(190,190,190)';
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
    const { height: screenHeight } = useWindowDimensions();
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
    const maxCardHeight = screenHeight - insets.top - insets.bottom - 48;

    let message: string | null = null;
    if (phase.kind === 'thanks') message = t('feedbackRequest.thanks');
    else if (phase.kind === 'already') message = t('feedbackRequest.alreadyAnswered');
    else if (phase.kind === 'closed') message = t('feedbackRequest.closed');
    else if (phase.kind === 'load-error') message = phase.offline ? t('feedbackRequest.offline') : t('feedbackRequest.loadError');

    return (
        <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <Pressable
                style={StyleSheet.absoluteFill}
                onPress={backdropCloses ? onClose : undefined}
                accessible={false}
                importantForAccessibility="no"
            />
            <View testID="feedback-request-card" style={[styles.card, { maxHeight: maxCardHeight }]}>
                {/* The modal material (components/ui/modal). */}
                <AbstractGradientBackdrop seed="mera-modal" frame={0} />
                <TranslucentPlate />
                <View style={styles.header}>
                    <View style={styles.headerTitle}>
                        <MeraLogo size={30} />
                        <Text size="md" bold className="text-white flex-1" accessibilityRole="header">
                            {t('feedbackRequest.title')}
                        </Text>
                    </View>
                    <Pressable
                        testID="feedback-request-close"
                        onPress={onClose}
                        accessibilityLabel={t('feedbackRequest.close')}
                        accessibilityRole="button"
                        hitSlop={12}
                        style={styles.closeButton}
                    >
                        <MaterialIcons name="close" size={22} color="#fff" />
                    </Pressable>
                </View>

                <ScrollView
                    keyboardShouldPersistTaps="handled"
                    bounces={false}
                    contentContainerStyle={styles.body}
                >
                    {phase.kind === 'loading' ? (
                        <ActivityIndicator
                            testID="feedback-request-loading"
                            color={ACCENT}
                            style={styles.spinner}
                            accessibilityLabel={t('common.loading')}
                        />
                    ) : null}

                    {question && phase.kind !== 'loading' && phase.kind !== 'load-error' ? (
                        <Text testID="feedback-request-question" size="lg" className="text-white">
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
                                    className="py-3 text-white"
                                />
                            </Input>
                            {answer.length >= COUNTER_FROM ? (
                                <Text
                                    testID="feedback-request-counter"
                                    size="xs"
                                    style={styles.counter}
                                >
                                    {t('feedbackRequest.counter', {
                                        current: answer.length,
                                        max: FEEDBACK_RESPONSE_MAX_CHARS,
                                    })}
                                </Text>
                            ) : null}
                            {phase.kind === 'error' ? (
                                <Text testID="feedback-request-error" size="sm" className="text-red-400 mt-3">
                                    {phase.offline ? t('feedbackRequest.offline') : t('feedbackRequest.error')}
                                </Text>
                            ) : null}
                            {/* What leaves the device with the answer, said
                                before the button that sends it. */}
                            <Text testID="feedback-request-disclaimer" size="xs" style={styles.disclaimer}>
                                {t('feedbackRequest.disclaimer')}
                            </Text>
                            <Pressable
                                testID="feedback-request-submit"
                                onPress={() => void handleSubmit()}
                                disabled={!canSubmit}
                                accessibilityRole="button"
                                accessibilityLabel={t('feedbackRequest.submit')}
                                accessibilityState={{ disabled: !canSubmit, busy: submitting }}
                                style={[styles.primaryButton, !canSubmit && styles.buttonDisabled]}
                            >
                                {submitting ? (
                                    <ActivityIndicator color="#000" />
                                ) : (
                                    <Text size="md" bold style={styles.primaryButtonText}>
                                        {t('feedbackRequest.submit')}
                                    </Text>
                                )}
                            </Pressable>
                        </>
                    ) : null}

                    {message ? (
                        <Text
                            testID={`feedback-request-${phase.kind}`}
                            size="md"
                            style={styles.message}
                            accessibilityLiveRegion="polite"
                        >
                            {message}
                        </Text>
                    ) : null}

                    {phase.kind === 'load-error' ? (
                        <Pressable
                            testID="feedback-request-retry"
                            onPress={() => void load()}
                            accessibilityRole="button"
                            accessibilityLabel={t('feedbackRequest.retry')}
                            style={styles.primaryButton}
                        >
                            <Text size="md" bold style={styles.primaryButtonText}>
                                {t('feedbackRequest.retry')}
                            </Text>
                        </Pressable>
                    ) : null}

                    {phase.kind === 'thanks' || phase.kind === 'already' || phase.kind === 'closed' ? (
                        <Pressable
                            testID="feedback-request-done"
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel={t('feedbackRequest.close')}
                            style={styles.primaryButton}
                        >
                            <Text size="md" bold style={styles.primaryButtonText}>
                                {t('feedbackRequest.close')}
                            </Text>
                        </Pressable>
                    ) : null}
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    root: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
    },
    card: {
        width: '100%',
        maxWidth: 480,
        borderRadius: 24,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgb(18, 17, 19)',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 2,
        gap: 12,
    },
    headerTitle: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    closeButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: CLOSE_RED,
        justifyContent: 'center',
        alignItems: 'center',
    },
    body: {
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 20,
    },
    spinner: {
        marginVertical: 24,
    },
    counter: {
        color: SECONDARY,
        textAlign: 'right',
        marginTop: 6,
    },
    disclaimer: {
        color: SECONDARY,
        marginTop: 12,
        lineHeight: 18,
    },
    message: {
        color: 'rgb(220,220,220)',
        marginTop: 12,
        lineHeight: 22,
    },
    // Grows with its label: a long translation wraps inside a taller button
    // rather than being clipped by a fixed height.
    primaryButton: {
        marginTop: 16,
        minHeight: 48,
        borderRadius: 24,
        paddingHorizontal: 20,
        paddingVertical: 12,
        backgroundColor: ACCENT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    primaryButtonText: {
        color: '#000',
        textAlign: 'center',
    },
});

export default FeedbackRequestModal;
