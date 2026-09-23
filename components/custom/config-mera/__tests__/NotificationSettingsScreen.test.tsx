/* eslint-disable @typescript-eslint/no-require-imports */
// F43 / M22: the delivery hours save on their own. There used to be a "Save
// Preferences" button ~850pt below the toggle, and leaving without pressing it
// silently dropped the change.
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/switch', () => { const { View } = require('react-native'); return { Switch: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: ({ children, ...p }: any) => <Pressable {...p}>{children}</Pressable>, ButtonText: ({ children }: any) => <Text>{children}</Text> };
});
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: () => null, ToastTitle: () => null, ToastDescription: () => null,
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getSession: async () => ({ data: { user: { id: 'u1' } } }) } }));
const mockUpdatePrefs = jest.fn(async (_u: string, _h: number[]) => undefined);
jest.mock('@/lib/account-service', () => ({
    AccountService: {
        getUserPersona: async () => ({ notificationsEnabled: true, preferredNotificationWindow: [8] }),
        updateNotificationPreferences: (u: string, h: number[]) => mockUpdatePrefs(u, h),
    },
}));
jest.mock('@/lib/notification-service', () => ({
    hasUserDeniedPermissions: async () => false,
    setVisibleNotificationsEnabled: async () => true,
}));
jest.mock('@/lib/notificationSlotUtils', () => ({
    convertLocalHoursToUTC: (h: number[]) => h,
    convertUTCHoursToLocal: (h: number[]) => h,
}));
jest.mock('@/components/custom/NotificationHourWheel', () => {
    const { Pressable, View } = require('react-native');
    return {
        __esModule: true,
        default: ({ onHoursChange }: any) => (
            <View>
                <Pressable testID="wheel-pick-8-20" onPress={() => onHoursChange([8, 20])} />
                <Pressable testID="wheel-clear" onPress={() => onHoursChange([])} />
            </View>
        ),
    };
});

import NotificationSettingsScreen from '../NotificationSettingsScreen';

beforeEach(() => {
    jest.useFakeTimers();
    mockUpdatePrefs.mockClear();
});
afterEach(() => jest.useRealTimers());

async function ready() {
    const r = render(<NotificationSettingsScreen onBack={jest.fn()} />);
    await waitFor(() => r.getByTestId('wheel-pick-8-20'));
    return r;
}

describe('notification hours auto-save', () => {
    it('saves a change on its own, without a Save button', async () => {
        const r = await ready();
        expect(r.queryByText('notifications.savePreferences')).toBeNull();
        fireEvent.press(r.getByTestId('wheel-pick-8-20'));
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(mockUpdatePrefs).toHaveBeenCalledWith('u1', [8, 20]);
        await waitFor(() => r.getByText('notifications.savedInline'));
    });

    it('does not save an empty selection and says why', async () => {
        const r = await ready();
        fireEvent.press(r.getByTestId('wheel-clear'));
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(mockUpdatePrefs).not.toHaveBeenCalled();
        expect(r.getByText('notifications.pickAtLeastOneHour')).toBeTruthy();
    });

    it('saves a pending change when the screen closes before the delay', async () => {
        const r = await ready();
        fireEvent.press(r.getByTestId('wheel-pick-8-20'));
        r.unmount();
        await act(async () => {});
        expect(mockUpdatePrefs).toHaveBeenCalledWith('u1', [8, 20]);
    });

    it('labels the counter through i18n', async () => {
        const r = await ready();
        expect(r.getByText('notifications.selectedLabel')).toBeTruthy();
    });
});
