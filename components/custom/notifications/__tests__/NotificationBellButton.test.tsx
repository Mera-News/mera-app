/* eslint-disable @typescript-eslint/no-require-imports */
// Owner: the Dashboard bell is "the same size and style as the search icon in
// Explore": both are the shared HeaderIconButton now. The unread count stays
// visible as a badge on the glyph and is read in the button's own label.

import { render } from '@testing-library/react-native';
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
        t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    }),
}));
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID={`icon-${p.name}`} {...p} /> };
});
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/notifications/bell-anchor', () => ({ setBellAnchor: jest.fn() }));
let mockUnread = 0;
jest.mock('@/lib/database/services/notification-service', () => ({
    observeUnreadCount: () => ({
        subscribe: (fn: (n: number) => void) => {
            fn(mockUnread);
            return { unsubscribe: jest.fn() };
        },
    }),
}));

import { StyleSheet } from 'react-native';
import NotificationBellButton from '../NotificationBellButton';

const HIDDEN = { includeHiddenElements: true } as const;

describe('NotificationBellButton', () => {
    beforeEach(() => {
        mockUnread = 0;
    });

    it('matches the Explore search button: 44pt frame, white 24pt glyph, no chip', () => {
        const { getByTestId } = render(<NotificationBellButton />);
        const bell = getByTestId('feed-notification-bell');
        expect(StyleSheet.flatten(bell.props.style)).toMatchObject({ width: 44, height: 44, margin: -10 });
        expect(bell.props.hitSlop).toBeUndefined();
        expect(bell.props.className ?? '').not.toMatch(/border|rounded|p-3/);
        const icon = getByTestId('icon-notifications-none');
        expect(icon.props.size).toBe(24);
        expect(icon.props.color).toBe('#ffffff');
    });

    it('reads the unread count in its own label and hides the badge from accessibility', () => {
        mockUnread = 3;
        const { getByTestId, getByText } = render(<NotificationBellButton />);
        expect(getByTestId('feed-notification-bell').props.accessibilityLabel).toBe(
            'notificationCenter.bellA11y, trackedStories.updatesBadge:{"count":3}',
        );
        expect(getByText('3', HIDDEN)).toBeTruthy();
        const badge = getByTestId('feed-notification-bell-badge', HIDDEN);
        expect(badge.props.accessibilityElementsHidden).toBe(true);
        expect(badge.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('keeps the plain label with nothing unread', () => {
        const { getByTestId, queryByTestId } = render(<NotificationBellButton />);
        expect(getByTestId('feed-notification-bell').props.accessibilityLabel).toBe('notificationCenter.bellA11y');
        expect(queryByTestId('feed-notification-bell-badge', HIDDEN)).toBeNull();
    });
});
