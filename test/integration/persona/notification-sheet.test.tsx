/**
 * The notification sheets at their host seam (NotificationSheetHost, mounted once in the logged-in
 * layout): What's new opens from the update-notes store wherever the reader is, Update ready opens from
 * an update_available row tap, and a sheet's action runs only after the sheet has gone. Real stores,
 * real notification service, real tapNotification. Mocked: the RN Modal native spec and expo-updates
 * (native edges).
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { t } from 'i18next';
import NotificationSheetHost from '@/components/custom/notifications/NotificationSheetHost';
import { tapNotification, useNotificationSheet } from '@/components/custom/notifications/notification-actions';
import { getAll, notify } from '@/lib/database/services/notification-service';
import { RESTART_FOR_UPDATE, UPDATE_AVAILABLE, useOpenUpdateNotes } from '@/lib/ota-notice';
import { COLORS } from '@/lib/theme/tokens';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null),
    };
});
// The shared Reanimated mock has no useReducedMotion, which the sheet reads.
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
jest.mock('expo-updates', () => ({
    isEnabled: true,
    updateId: null,
    createdAt: null,
    isEmbeddedLaunch: false,
    latestContext: {},
    reloadAsync: async () => {},
    checkForUpdateAsync: async () => ({ isAvailable: false }),
    fetchUpdateAsync: async () => ({ isNew: false }),
}));

const c = COLORS.dark;
const statusOf = async (id: string) => (await getAll()).find((n) => n.id === id)?.status;

beforeAll(initI18nEn);
beforeEach(() => {
    useOpenUpdateNotes.setState({ open: false, notes: [] });
    useNotificationSheet.setState({ updateReady: null, updateReadyOpen: false, notesAt: null });
});

describe("What's new", () => {
    it('opens from the store anywhere (the "See what\'s new" toast), with dated notes, and Done closes it', async () => {
        render(<NotificationSheetHost />);
        expect(screen.queryByTestId('update-notes')).toBeNull();
        act(() =>
            useOpenUpdateNotes.setState({
                open: true,
                notes: [
                    { at: '2026-10-27T09:00:00.000Z', message: 'Duplicate stories now show as one card' },
                    { at: '2026-10-26T09:00:00.000Z', message: 'A new Activity page' },
                ],
            }),
        );
        expect(screen.getByText(t('notificationCenter.update.notesTitle'))).toBeTruthy();
        expect(screen.getByText('Duplicate stories now show as one card')).toBeTruthy();
        expect(screen.getByText('A new Activity page')).toBeTruthy();
        // Opened from the toast, not a row: it just happened.
        expect(screen.getByText(t('notificationCenter.ageNow'))).toBeTruthy();
        const title = screen.getByText(t('notificationCenter.update.notesTitle'));
        expect(StyleSheet.flatten(title.props.style)).toMatchObject({ fontSize: 20, lineHeight: 26, color: c.ink });

        fireEvent.press(screen.getByTestId('update-notes-done'));
        expect(useOpenUpdateNotes.getState().open).toBe(false);
    });

    it('with no notes says so', () => {
        render(<NotificationSheetHost />);
        act(() => useOpenUpdateNotes.setState({ open: true, notes: [] }));
        expect(screen.getByText(t('notificationCenter.update.notesEmpty'))).toBeTruthy();
    });
});

describe('Update ready', () => {
    const seedUpdate = async () => {
        const row = await notify({
            type: UPDATE_AVAILABLE,
            title: 'notificationCenter.update.availableTitle',
            body: 'notificationCenter.update.availableBody',
            source: 'ota',
            actions: [{ id: RESTART_FOR_UPDATE, labelKey: 'notificationCenter.update.restart' }],
        });
        if (!row) throw new Error('no row');
        return row;
    };

    it('a row tap opens it with Restart (filled) and Not now (outlined)', async () => {
        render(<NotificationSheetHost />);
        const row = await seedUpdate();
        await act(() => tapNotification(row));
        expect(screen.getByText(t('notificationCenter.update.availableTitle'))).toBeTruthy();
        expect(screen.getByText(t('notificationCenter.update.availableBody'))).toBeTruthy();
        expect(StyleSheet.flatten(screen.getByTestId('update-ready-restart').props.style)).toMatchObject({
            height: 50,
            backgroundColor: c.accent,
        });
        expect(StyleSheet.flatten(screen.getByTestId('update-ready-not-now').props.style)).toMatchObject({
            height: 50,
            borderWidth: 1,
        });
    });

    it('Restart closes the sheet first and runs the restart once it has gone', async () => {
        render(<NotificationSheetHost />);
        const row = await seedUpdate();
        await act(() => tapNotification(row));
        fireEvent.press(screen.getByTestId('update-ready-restart'));
        expect(useNotificationSheet.getState().updateReadyOpen).toBe(false);
        // Still read while the sheet leaves: nothing ran on the tap itself.
        expect(await statusOf(row.id)).toBe('read');
        await waitFor(async () => expect(await statusOf(row.id)).toBe('actioned'));
    });

    it('Not now closes it and runs nothing', async () => {
        render(<NotificationSheetHost />);
        const row = await seedUpdate();
        await act(() => tapNotification(row));
        fireEvent.press(screen.getByTestId('update-ready-not-now'));
        expect(useNotificationSheet.getState().updateReadyOpen).toBe(false);
        await act(() => new Promise((r) => setTimeout(r, 1400)));
        expect(await statusOf(row.id)).toBe('read');
    });
});
