import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConsentSessionUser } from '@/components/custom/auth/legal-consent';
import { authClient } from '@/lib/auth-client';
import { markActionedBySource } from '@/lib/database/services/notification-service';
import {
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
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { isFeedbackRequestId } from '@/lib/stores/pending-notification-route';
import { useUserStore } from '@/lib/stores/user-store';
import { consentBlocksFeedbackRequest } from './feedback-request-consent';

type Phase =
    | { kind: 'loading' }
    | { kind: 'load-error'; offline: boolean }
    | { kind: 'open' }
    | { kind: 'submitting' }
    | { kind: 'error'; offline: boolean }
    | { kind: 'thanks' }
    | { kind: 'already' }
    | { kind: 'closed' };

type ConsentPhase = 'checking' | 'clear' | 'blocked';

export const useFeedbackRequestConsent = (onClose: () => void) => {
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
    return { consent };
};

export const useFeedbackRequestCard = (id: string | undefined) => {
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
    return { phase, question, answer, setAnswer, load, handleSubmit, showsTextArea, submitting, canSubmit, backdropCloses };
};
