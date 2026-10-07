// What tapping an inbox row or its one button does. Shared by the inbox page
// (NotificationsScreen) and the notice's button (NotifiedToast), so a notice
// and its inbox row can never do different things.
import { navigateToTabScreen } from '@/components/custom/nav/navigate-to-page';
import type NotificationModel from '@/lib/database/models/Notification';
import { markActioned, markRead } from '@/lib/database/services/notification-service';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { isFeedbackRequestId } from '@/lib/stores/pending-notification-route';
import { router } from 'expo-router';
import i18next from 'i18next';

export type NotificationAction = { id: string; labelKey?: string; label?: string };

/** Written by lib/fact-check/fact-check-settled for a check this device asked for. */
export const FACT_CHECK_DONE = 'fact_check_done';
/** Written by lib/feedback-requests/feedback-request-sync, one per request. Its
 *  body is the question itself (free text, never an i18n key). */
export const FEEDBACK_REQUEST = 'feedback_request';

/** Safe JSON.parse to an object; null on failure or empty. */
export function parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** i18n key or raw text: i18next returns the key itself on a miss, which for
 *  free agent text IS the display text. */
export function resolveText(key: string, params?: Record<string, unknown>): string {
    if (!key) return '';
    const resolved = (i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string)(key, params ?? {});
    return typeof resolved === 'string' ? resolved : key;
}

export function actionLabel(action: NotificationAction): string {
    return action.labelKey ? resolveText(action.labelKey) : action.label ?? action.id;
}

/** Opens the floating Mera chat pre-staged with a synthesized message. */
function openChatWith(message: string): void {
    useFloatingChatStore.getState().openArticleFeedback({ kind: 'persona' }, message);
}

/** A finished fact check opens its article through the same resolver an OS
 *  tap uses. Lazy: notification-service pulls in expo-notifications. */
async function openFactCheck(n: NotificationModel): Promise<void> {
    const context = parseJson<Record<string, unknown>>(n.contextJson) ?? {};
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveNotificationRoute } = require('@/lib/notification-service') as typeof import('@/lib/notification-service');
    router.push(await resolveNotificationRoute({ ...context, type: FACT_CHECK_DONE }));
}

/** A tap on the row itself. */
export async function openNotification(n: NotificationModel): Promise<void> {
    try {
        await markRead(n.id);
    } catch (err) {
        logger.captureException(err, { tags: { component: 'notification-actions', method: 'markRead' } });
    }
    if (n.type === FACT_CHECK_DONE) {
        await openFactCheck(n);
        return;
    }
    // Before the chat fallback, which would open chat for this row (it
    // carries context). The modal shows the closed or answered state itself.
    if (n.type === FEEDBACK_REQUEST) {
        const id = parseJson<Record<string, unknown>>(n.contextJson)?.feedbackRequestId;
        if (isFeedbackRequestId(id)) router.push({ pathname: '/logged-in/feedback-request', params: { id } });
        return;
    }
    if (!n.contextJson && !n.actionsJson) return; // informational: mark read only
    openChatWith(resolveText(n.body, parseJson<Record<string, unknown>>(n.contextJson) ?? undefined));
}

/** The row's one button (its first action). */
export async function runNotificationAction(n: NotificationModel, action: NotificationAction): Promise<void> {
    try {
        await markActioned(n.id);
    } catch (err) {
        logger.captureException(err, { tags: { component: 'notification-actions', method: 'markActioned' } });
    }
    switch (action.id) {
        case 'open-fact-check':
            await openFactCheck(n);
            return;
        case 'recalibrate':
            // The calibration invitation, not the raw chip label; the in-chat
            // affordance runs the calibration on an explicit confirm.
            openChatWith(resolveText('calibration.chatIntro', parseJson<Record<string, unknown>>(n.contextJson) ?? undefined));
            return;
        case 'review-hygiene':
            navigateToTabScreen('you', 'hygiene-review');
            return;
        case 'review-plan':
            useFloatingChatStore.getState().openOptimisationPlan();
            return;
        default:
            openChatWith(actionLabel(action));
    }
}
