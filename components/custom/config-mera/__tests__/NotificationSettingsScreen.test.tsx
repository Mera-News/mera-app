/* eslint-disable @typescript-eslint/no-require-imports */
// Settings > Notifications (and the onboarding step): push switch, picked
// hours as pills, a cursor wheel, and an add button for the outlined hour.
// Hours save on their own; there is no Save button.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: Record<string, unknown>) => (o && 'time' in o ? `${k}:${o.time}` : k),
        i18n: { language: 'en-US' },
    }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/scroll-view', () => { const { View } = require('react-native'); return { ScrollView: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/switch', () => { const { View } = require('react-native'); return { Switch: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: () => null, ToastTitle: () => null, ToastDescription: () => null,
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getSession: async () => ({ data: { user: { id: 'u1' } } }) } }));
const mockUpdatePrefs = jest.fn(async (_u: string, _h: number[]) => undefined);
let mockPersona: { notificationsEnabled: boolean; preferredNotificationWindow: number[] } = {
    notificationsEnabled: true,
    preferredNotificationWindow: [8],
};
jest.mock('@/lib/account-service', () => ({
    AccountService: {
        getUserPersona: async () => mockPersona,
        updateNotificationPreferences: (u: string, h: number[]) => mockUpdatePrefs(u, h),
    },
}));
const mockDenied = jest.fn(async () => false);
jest.mock('@/lib/notification-service', () => ({
    hasUserDeniedPermissions: () => mockDenied(),
    setVisibleNotificationsEnabled: async () => true,
}));
jest.mock('@/lib/notificationSlotUtils', () => ({
    convertLocalHoursToUTC: (h: number[]) => h,
    convertUTCHoursToLocal: (h: number[]) => h,
}));
// The real wheel is a 9,624-row FlatList; the screen only needs its cursor.
jest.mock('@/components/custom/NotificationHourWheel', () => {
    const { Pressable } = require('react-native');
    const actual = jest.requireActual('@/components/custom/NotificationHourWheel');
    return {
        __esModule: true,
        formatHourLabel: actual.formatHourLabel,
        default: ({ onCursorChange }: any) => (
            <>
                <Pressable testID="wheel-to-8" onPress={() => onCursorChange(8)} />
                <Pressable testID="wheel-to-20" onPress={() => onCursorChange(20)} />
            </>
        ),
    };
});

import NotificationSettingsScreen, { initialCursorHour } from '../NotificationSettingsScreen';

beforeEach(() => {
    jest.useFakeTimers();
    mockUpdatePrefs.mockClear();
    mockDenied.mockImplementation(async () => false);
    mockPersona = { notificationsEnabled: true, preferredNotificationWindow: [8] };
});
afterEach(() => jest.useRealTimers());

async function ready() {
    const r = render(<NotificationSettingsScreen onBack={jest.fn()} />);
    await waitFor(() => r.getByTestId('wheel-to-20'));
    return r;
}

describe('initialCursorHour', () => {
    it('starts on 08:00, else the first free hour after the latest pick', () => {
        expect(initialCursorHour([])).toBe(8);
        expect(initialCursorHour([8])).toBe(9);
        expect(initialCursorHour([8, 23])).toBe(0);
    });
});

describe('picking hours', () => {
    it('adds the outlined hour and saves on its own, without a Save button', async () => {
        const r = await ready();
        expect(r.queryByText('notifications.savePreferences')).toBeNull();
        fireEvent.press(r.getByTestId('wheel-to-20'));
        fireEvent.press(r.getByTestId('notifications-add-time'));
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(mockUpdatePrefs).toHaveBeenCalledWith('u1', [8, 20]);
        await waitFor(() => r.getByText('notifications.savedInline'));
    });

    it('says an already picked hour is picked instead of adding it twice', async () => {
        const r = await ready();
        fireEvent.press(r.getByTestId('wheel-to-8'));
        expect(r.getByText('you.notifications.alreadyPicked:08:00')).toBeTruthy();
        fireEvent.press(r.getByTestId('notifications-add-time'));
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(mockUpdatePrefs).not.toHaveBeenCalled();
    });

    it('removing the last time does not save and says what that means', async () => {
        const r = await ready();
        const remove = r.getByTestId('notifications-pill-remove-8');
        expect(remove.props.accessibilityLabel).toBe('you.notifications.remove:08:00');
        fireEvent.press(remove);
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(mockUpdatePrefs).not.toHaveBeenCalled();
        expect(r.getByTestId('notifications-zero-times')).toBeTruthy();
        // First pick is one full-width button for the outlined hour.
        expect(r.getByTestId('notifications-add-first')).toBeTruthy();
    });

    it('saves a pending change when the screen closes before the delay', async () => {
        const r = await ready();
        fireEvent.press(r.getByTestId('wheel-to-20'));
        fireEvent.press(r.getByTestId('notifications-add-time'));
        r.unmount();
        await act(async () => {});
        expect(mockUpdatePrefs).toHaveBeenCalledWith('u1', [8, 20]);
    });

    it('shows 24-hour times by default and switches to AM/PM', async () => {
        const r = await ready();
        expect(r.getByText('08:00')).toBeTruthy();
        fireEvent.press(r.getByTestId('notifications-format-ampm'));
        expect(r.getByText('8 AM')).toBeTruthy();
    });
});

describe('push refused by the phone', () => {
    it('links to phone settings only when the phone refused', async () => {
        mockPersona = { notificationsEnabled: false, preferredNotificationWindow: [] };
        mockDenied.mockImplementation(async () => true);
        const r = render(<NotificationSettingsScreen onBack={jest.fn()} />);
        await waitFor(() => r.getByTestId('notifications-open-device-settings'));
        expect(r.queryByTestId('wheel-to-20')).toBeNull();
    });

    it('says nothing about phone settings when push is merely off', async () => {
        mockPersona = { notificationsEnabled: false, preferredNotificationWindow: [] };
        const r = render(<NotificationSettingsScreen onBack={jest.fn()} />);
        await waitFor(() => r.getByTestId('notifications-push-switch'));
        await act(async () => {});
        expect(r.queryByTestId('notifications-os-refused')).toBeNull();
    });
});

describe('onboarding', () => {
    it('reports picks to the wizard and saves nothing itself', async () => {
        const onHoursChange = jest.fn();
        const r = render(
            <NotificationSettingsScreen isOnboarding initialHours={[]} onHoursChange={onHoursChange} />,
        );
        await waitFor(() => r.getByTestId('notifications-add-first'));
        fireEvent.press(r.getByTestId('notifications-add-first'));
        expect(onHoursChange).toHaveBeenCalledWith([8]);
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(mockUpdatePrefs).not.toHaveBeenCalled();
    });
});
