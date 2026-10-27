/**
 * One inbox row (Feed > Notifications) at its component seam: the tone badge from the shared notice map,
 * the unread dot and semibold title, title with its age, a two-line body preview, the spoken label, and
 * the delete beside the press area. Rows are written by the real notification service and read back.
 * Colour is asserted from style props, so these checks see what the device paints.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { t } from 'i18next';
import NotificationRow from '@/components/custom/notifications/NotificationRow';
import { useNotificationSheet } from '@/components/custom/notifications/notification-actions';
import { getAll, markRead, notify, type NotifyInput } from '@/lib/database/services/notification-service';
import { RESTART_FOR_UPDATE, UPDATE_AVAILABLE } from '@/lib/ota-notice';
import { COLORS, tint } from '@/lib/theme/tokens';
import { initI18nEn } from '@/test/helpers';

const c = COLORS.dark;
const flat = (testID: string) =>
    StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements: true }).props.style);

async function seed(input: Partial<NotifyInput> & Pick<NotifyInput, 'type'>) {
    const row = await notify({ title: 'title', body: 'body', source: `test:${input.type}`, ...input });
    if (!row) throw new Error('notify returned no row');
    return row;
}

const updateRow = () =>
    seed({
        type: UPDATE_AVAILABLE,
        title: 'notificationCenter.update.availableTitle',
        body: 'notificationCenter.update.availableBody',
        actions: [{ id: RESTART_FOR_UPDATE, labelKey: 'notificationCenter.update.restart' }],
    });

const mount = (row: Awaited<ReturnType<typeof seed>>) => render(<NotificationRow n={row} first last motion={false} />);

beforeAll(initI18nEn);
beforeEach(() => useNotificationSheet.setState({ updateReady: null, updateReadyOpen: false, notesAt: null }));

describe('NotificationRow', () => {
    it('draws the tone badge its toast uses, the title with its age, and a two-line body preview', async () => {
        const row = await updateRow();
        mount(row);
        // update_available is info: the badge fill is the info tone at the dark 16% tint.
        expect(flat('mera-toast-badge').backgroundColor).toBe(tint(c.info, 0.16));
        expect(screen.getByText(t('notificationCenter.update.availableTitle'))).toBeTruthy();
        expect(screen.getByText(t('notificationCenter.ageNow'))).toBeTruthy();
        const body = screen.getByText(t('notificationCenter.update.availableBody'));
        expect(body.props.numberOfLines).toBe(2);
        expect(StyleSheet.flatten(body.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20, color: c.ink2 });
    });

    it('a fact check row takes its tone from the outcome', async () => {
        const row = await seed({ type: 'fact_check_done', context: { outcome: 'found' } });
        mount(row);
        expect(flat('mera-toast-badge').backgroundColor).toBe(tint(c.positive, 0.16));
    });

    it('unread: a dot on the badge, a semibold title, and "unread" in what VoiceOver hears', async () => {
        const row = await updateRow();
        mount(row);
        expect(screen.getByTestId(`notification-unread-${row.id}`, { includeHiddenElements: true })).toBeTruthy();
        const title = screen.getByText(t('notificationCenter.update.availableTitle'));
        expect(StyleSheet.flatten(title.props.style).fontWeight).toBe('600');
        const label = screen.getByTestId(`notification-row-${row.id}`).props.accessibilityLabel as string;
        expect(label.startsWith(
            t('notificationCenter.rowUnreadA11y', {
                title: t('notificationCenter.update.availableTitle'),
                age: t('notificationCenter.ageNow'),
            }),
        )).toBe(true);
        // The preview is spoken too: the dot and the body are not visible to VoiceOver otherwise.
        expect(label).toContain(t('notificationCenter.update.availableBody'));
    });

    it('read: no dot, a regular title, no "unread"', async () => {
        const seeded = await updateRow();
        await markRead(seeded.id);
        const row = (await getAll()).find((n) => n.id === seeded.id)!;
        mount(row);
        expect(screen.queryByTestId(`notification-unread-${row.id}`, { includeHiddenElements: true })).toBeNull();
        const title = screen.getByText(t('notificationCenter.update.availableTitle'));
        expect(StyleSheet.flatten(title.props.style).fontWeight).toBe('400');
        expect(screen.getByTestId(`notification-row-${row.id}`).props.accessibilityLabel).not.toContain('unread');
    });

    it('a feedback question shows its free text as written, never through t()', async () => {
        const row = await seed({ type: 'feedback_request', title: 'feedbackRequest.title', body: 'What: do you think?' });
        mount(row);
        expect(screen.getByText('What: do you think?')).toBeTruthy();
    });

    it('a tap on an update row opens the Update ready sheet; delete removes the row and opens nothing', async () => {
        const row = await updateRow();
        mount(row);
        fireEvent.press(screen.getByTestId(`notification-row-${row.id}`));
        await waitFor(() => expect(useNotificationSheet.getState().updateReadyOpen).toBe(true));

        const other = await updateRow();
        useNotificationSheet.setState({ updateReady: null, updateReadyOpen: false });
        render(<NotificationRow n={other} first last motion={false} />);
        fireEvent.press(screen.getByTestId(`notification-delete-${other.id}`));
        await waitFor(async () => expect((await getAll()).map((n) => n.id)).not.toContain(other.id));
        expect(useNotificationSheet.getState().updateReadyOpen).toBe(false);
    });
});
