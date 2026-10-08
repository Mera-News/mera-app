// An inbox row tap does exactly what the row's button did when rows were
// cards: each written notification type, through its own handler.

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
const mockNavigateToTabScreen = jest.fn();
jest.mock('@/components/custom/nav/navigate-to-page', () => ({
    navigateToTabScreen: (...a: unknown[]) => mockNavigateToTabScreen(...a),
}));
const mockMarkRead = jest.fn(async () => undefined);
const mockMarkActioned = jest.fn(async () => undefined);
jest.mock('@/lib/database/services/notification-service', () => ({
    markRead: (...a: unknown[]) => mockMarkRead(...(a as [])),
    markActioned: (...a: unknown[]) => mockMarkActioned(...(a as [])),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
const mockOpenArticleFeedback = jest.fn();
const mockOpenOptimisationPlan = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatStore: {
        getState: () => ({ openArticleFeedback: mockOpenArticleFeedback, openOptimisationPlan: mockOpenOptimisationPlan }),
    },
}));
jest.mock('@/lib/stores/pending-notification-route', () => ({
    isFeedbackRequestId: (id: unknown) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id),
}));
const mockResolveRoute = jest.fn(async () => '/logged-in/article-detail?articleId=a1');
jest.mock('@/lib/notification-service', () => ({ resolveNotificationRoute: (...a: unknown[]) => mockResolveRoute(...(a as [])) }));
jest.mock('i18next', () => ({ __esModule: true, default: { t: (key: string) => `t:${key}` } }));

import type NotificationModel from '@/lib/database/models/Notification';
import { tapNotification } from '../notification-actions';

const row = (type: string, actions: unknown[] | null, context: Record<string, unknown> = {}) =>
    ({
        id: `n-${type}`,
        type,
        title: 'title',
        body: 'body',
        contextJson: JSON.stringify(context),
        actionsJson: actions ? JSON.stringify(actions) : null,
        status: 'unread',
    }) as unknown as NotificationModel;

beforeEach(() => jest.clearAllMocks());

test('hygiene opens Tidy up', async () => {
    await tapNotification(row('hygiene', [{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }]));
    expect(mockNavigateToTabScreen).toHaveBeenCalledWith('you', 'hygiene-review');
    expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
    expect(mockMarkActioned).toHaveBeenCalledWith('n-hygiene');
});

test('calibration opens the recalibration chat with its invitation', async () => {
    await tapNotification(row('calibration', [{ id: 'recalibrate', labelKey: 'calibration.recalibrateChip' }]));
    expect(mockOpenArticleFeedback).toHaveBeenCalledWith({ kind: 'persona' }, 't:calibration.chatIntro');
});

test('an optimisation plan opens the plan', async () => {
    await tapNotification(row('optimisation_plan', [{ id: 'review-plan', labelKey: 'optimisationPlan.reviewChip' }]));
    expect(mockOpenOptimisationPlan).toHaveBeenCalledTimes(1);
    expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
});

test('a finished fact check opens its article', async () => {
    await tapNotification(row('fact_check_done', [{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }], { articleId: 'a1' }));
    expect(mockResolveRoute).toHaveBeenCalledWith(expect.objectContaining({ type: 'fact_check_done', articleId: 'a1' }));
    expect(mockPush).toHaveBeenCalledWith('/logged-in/article-detail?articleId=a1');
});

test('a feedback question (no action) opens its modal', async () => {
    const id = 'a'.repeat(24);
    await tapNotification(row('feedback_request', null, { feedbackRequestId: id }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/logged-in/feedback-request', params: { id } });
    expect(mockMarkRead).toHaveBeenCalledWith('n-feedback_request');
    expect(mockMarkActioned).not.toHaveBeenCalled();
});
