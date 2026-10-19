// Tapping an inbox row (or the notice's button) through `tapNotification`: each written notice type does
// what its first action says, and the row is marked read or actioned. Rows are written by the real
// notification service, and the real router mock, floating-chat store, nav store, i18n and pending-route
// store are read back. Mocked: nothing of our own (expo-router and expo-notifications are the setup's native fakes).
import { t } from 'i18next';
import { router } from 'expo-router';
import { __resetMoveToPhoneForTests, subscribeMoveToPhone } from '@/components/custom/auth/move-to-phone';
import { tapNotification, NOT_KEPT_NOTICE_TYPES } from '@/components/custom/notifications/notification-actions';
import type NotificationModel from '@/lib/database/models/Notification';
import { deleteNotification, getAll, notify, type NotifyInput } from '@/lib/database/services/notification-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { consumePendingNotificationRoute } from '@/lib/stores/pending-notification-route';
import { initI18nEn } from '@/test/helpers';
import { consumePendingPage, resetPendingPage } from '@/components/custom/nav/navigate-to-page';

const nav = router as unknown as { push: jest.Mock; navigate: jest.Mock };

/** Writes one notice the way the app does and returns the stored row. */
async function seed(input: Partial<NotifyInput> & Pick<NotifyInput, 'type'>): Promise<NotificationModel> {
    const row = await notify({ title: 'title', body: 'body', source: `test:${input.type}`, ...input });
    if (!row) throw new Error('notify returned no row');
    return row;
}

const statusOf = async (id: string) => (await getAll()).find((n) => n.id === id)?.status;

beforeAll(async () => {
    await initI18nEn();
});

beforeEach(() => {
    useFloatingChatStore.getState().reset();
    resetPendingPage();
});

describe('tapNotification', () => {
    it('hygiene opens the inbox, where its suggestions are cards, and marks the row actioned', async () => {
        const row = await seed({ type: 'hygiene', actions: [{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }] });
        await tapNotification(row);
        expect(nav.navigate).toHaveBeenCalledWith('/logged-in/app_container/feed');
        expect(consumePendingPage('feed')?.page).toBe('notifications');
        expect(nav.push).not.toHaveBeenCalled();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
        expect(await statusOf(row.id)).toBe('actioned');
    });

    it('calibration opens the recalibration chat with its invitation, not the chip label', async () => {
        const row = await seed({ type: 'calibration', actions: [{ id: 'recalibrate', labelKey: 'calibration.recalibrateChip' }] });
        await tapNotification(row);
        const chat = useFloatingChatStore.getState();
        expect(chat.isExpanded).toBe(true);
        expect(chat.context).toEqual({ kind: 'persona' });
        const intro = t('calibration.chatIntro');
        expect(intro).not.toBe('calibration.chatIntro');
        expect(chat.pendingInitialMessage).toBe(intro);
        expect(await statusOf(row.id)).toBe('actioned');
    });

    it('an optimisation plan opens the plan card with nothing to send', async () => {
        const row = await seed({ type: 'optimisation_plan', actions: [{ id: 'review-plan', labelKey: 'optimisationPlan.reviewChip' }] });
        await tapNotification(row);
        const chat = useFloatingChatStore.getState();
        expect(chat.isExpanded).toBe(true);
        expect(chat.context).toEqual({ kind: 'optimisation-plan' });
        expect(chat.pendingInitialMessage).toBeNull();
        expect(await statusOf(row.id)).toBe('actioned');
    });

    it('a finished fact check opens its article', async () => {
        const row = await seed({
            type: 'fact_check_done',
            actions: [{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }],
            context: { articleId: 'a1' },
        });
        await tapNotification(row);
        expect(nav.push).toHaveBeenCalledWith({ pathname: '/logged-in/article-detail', params: { articleId: 'a1' } });
        expect(await statusOf(row.id)).toBe('actioned');
    });

    it('a finished fact check with no article falls back to the Feed', async () => {
        const row = await seed({ type: 'fact_check_done', actions: [{ id: 'open-fact-check' }], context: {} });
        await tapNotification(row);
        expect(nav.push).toHaveBeenCalledWith('/logged-in/app_container/feed');
    });

    it('an unknown action opens the chat seeded with its own label', async () => {
        const row = await seed({ type: 'agent_note', actions: [{ id: 'something-new', label: 'Ask about this' }] });
        await tapNotification(row);
        expect(useFloatingChatStore.getState().pendingInitialMessage).toBe('Ask about this');
        expect(await statusOf(row.id)).toBe('actioned');
    });

    it('the move to phone offer asks the host to open the move and marks the row actioned', async () => {
        __resetMoveToPhoneForTests();
        const asked = jest.fn();
        const stop = subscribeMoveToPhone(asked);
        const row = await seed({ type: 'move_to_phone', actions: [{ id: 'move-to-phone', labelKey: 'moveToPhone.settingsRow' }] });
        await tapNotification(row);
        stop();
        expect(asked).toHaveBeenCalledTimes(1);
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
        expect(await statusOf(row.id)).toBe('actioned');
    });

    it('only the first action runs', async () => {
        const row = await seed({
            type: 'hygiene',
            actions: [
                { id: 'review-hygiene', labelKey: 'hygiene.reviewChip' },
                { id: 'review-plan', labelKey: 'optimisationPlan.reviewChip' },
            ],
        });
        await tapNotification(row);
        expect(nav.navigate).toHaveBeenCalledTimes(1);
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    });
});

describe('tapNotification: rows with no action', () => {
    it('a feedback question opens its modal, marks the row read (not actioned) and stashes no route', async () => {
        const id = 'a'.repeat(24);
        const row = await seed({ type: 'feedback_request', context: { feedbackRequestId: id } });
        await tapNotification(row);
        expect(nav.push).toHaveBeenCalledWith({ pathname: '/logged-in/feedback-request', params: { id } });
        expect(await statusOf(row.id)).toBe('read');
        expect(await consumePendingNotificationRoute('any-user')).toBeNull();
    });

    it('a feedback question with a malformed id opens nothing and does not fall back to the chat', async () => {
        const row = await seed({ type: 'feedback_request', context: { feedbackRequestId: 'not-an-object-id' } });
        await tapNotification(row);
        expect(nav.push).not.toHaveBeenCalled();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
        expect(await statusOf(row.id)).toBe('read');
    });

    it('an informational row (no context, no actions) is only marked read', async () => {
        const row = await seed({ type: 'info', body: 'Nothing to do here' });
        await tapNotification(row);
        expect(nav.push).not.toHaveBeenCalled();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
        expect(await statusOf(row.id)).toBe('read');
    });

    it('a row with context but no action opens the chat seeded with its resolved body', async () => {
        const row = await seed({ type: 'agent_note', body: 'calibration.chatIntro', context: { topic: 'F1' } });
        await tapNotification(row);
        const chat = useFloatingChatStore.getState();
        expect(chat.isExpanded).toBe(true);
        expect(chat.pendingInitialMessage).toBe(t('calibration.chatIntro', { topic: 'F1' }));
        expect(await statusOf(row.id)).toBe('read');
    });

    it('free agent text in the body is shown as it is', async () => {
        const row = await seed({ type: 'agent_note', body: 'You follow a lot of cricket', context: { n: 1 } });
        await tapNotification(row);
        expect(useFloatingChatStore.getState().pendingInitialMessage).toBe('You follow a lot of cricket');
    });
});

describe('tapNotification: failures', () => {
    it('still opens the target when the row cannot be marked (a row already deleted)', async () => {
        const row = await seed({ type: 'hygiene', actions: [{ id: 'review-hygiene' }] });
        await deleteNotification(row.id);
        await tapNotification(row);
        expect(consumePendingPage('feed')?.page).toBe('notifications');
    });
});

describe('NOT_KEPT_NOTICE_TYPES', () => {
    it('names the three retired types the inbox hides, and none of the types still written', () => {
        expect([...NOT_KEPT_NOTICE_TYPES].sort()).toEqual(['feed_info', 'migration_done', 'sync_event']);
        for (const written of ['hygiene', 'calibration', 'optimisation_plan', 'fact_check_done', 'feedback_request']) {
            expect(NOT_KEPT_NOTICE_TYPES.has(written)).toBe(false);
        }
    });
});
