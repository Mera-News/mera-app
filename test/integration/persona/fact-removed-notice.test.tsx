// The fact_removed inbox row: its look, a body that is never clamped, and "Add it back", which drafts a
// chat message and sends nothing. Rows are written by the real notification service.
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { t } from 'i18next';
import NotificationRow from '@/components/custom/notifications/NotificationRow';
import { tapNotification } from '@/components/custom/notifications/notification-actions';
import { notify } from '@/lib/database/services/notification-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { initI18nEn } from '@/test/helpers';

const STATEMENT = 'Arsenal: title race. 2026 season';

const seed = async () => {
    const row = await notify({
        type: 'fact_removed',
        title: 'notifications.factRemovedTitle',
        body: 'notifications.factRemovedBody',
        source: 'test:fact_removed',
        context: { statement: STATEMENT },
        actions: [{ id: 'add-fact-back', labelKey: 'notifications.factRemovedAction' }],
    });
    if (!row) throw new Error('notify returned no row');
    return row;
};

beforeAll(initI18nEn);
beforeEach(() => useFloatingChatStore.getState().reset());

describe('fact_removed notice', () => {
    it('Add it back drafts the message with the statement intact and sends nothing', async () => {
        await tapNotification(await seed());
        const chat = useFloatingChatStore.getState();
        expect(chat.isExpanded).toBe(true);
        expect(chat.context).toEqual({ kind: 'persona' });
        expect(chat.pendingInitialMessage).toBeNull();
        expect(chat.pendingDraft).toBe(t('notifications.factRemovedDraft', { statement: STATEMENT }));
        expect(chat.pendingDraft).toContain(STATEMENT);
    });

    it('the body is not clamped and shows the statement intact', async () => {
        await render(<NotificationRow n={await seed()} first last motion={false} />);
        const body = screen.getByText(t('notifications.factRemovedBody', { statement: STATEMENT }));
        expect(body.props.numberOfLines).toBeUndefined();
        expect(body.props.children).toContain(STATEMENT);
    });
});
