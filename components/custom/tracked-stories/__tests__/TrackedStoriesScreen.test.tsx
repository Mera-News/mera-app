/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
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
    useTranslation: () => ({ t: (k: string, o?: any) => (o?.count != null ? `${k}:${o.count}` : k) }),
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// jest-expo mis-transforms RN's ScrollView native component ("Unexpected token
// 'export'") and FlatList's VirtualizedList tree is brittle under the test
// renderer. Proxy RN so ScrollView → View and FlatList → a trivial map that
// renders each row (or the empty component). Every other export stays real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            if (prop === 'FlatList') {
                return ({ data, renderItem, keyExtractor, ListEmptyComponent }: any) => {
                    if (!data || data.length === 0) {
                        if (ReactLib.isValidElement(ListEmptyComponent)) return ListEmptyComponent;
                        return typeof ListEmptyComponent === 'function'
                            ? ReactLib.createElement(ListEmptyComponent)
                            : null;
                    }
                    return ReactLib.createElement(
                        actual.View,
                        null,
                        data.map((item: any, index: number) =>
                            ReactLib.createElement(
                                actual.View,
                                { key: keyExtractor ? keyExtractor(item, index) : index },
                                renderItem({ item, index }),
                            ),
                        ),
                    );
                };
            }
            return (target as any)[prop];
        },
    });
});

let mockRows: any[] = [];
const mockUntrack = jest.fn();
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    observeActive: () => ({
        subscribe: (observer: any) => {
            observer.next(mockRows);
            return { unsubscribe: jest.fn() };
        },
    }),
    untrackStory: (...a: any[]) => mockUntrack(...a),
}));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    return {
        Modal: ({ isOpen, children }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: (p: any) => <View {...p} />,
        ModalBody: (p: any) => <View {...p} />,
        ModalContent: (p: any) => <View {...p} />,
        ModalFooter: (p: any) => <View {...p} />,
        ModalHeader: (p: any) => <View {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});

import { router } from 'expo-router';
import TrackedStoriesScreen from '../TrackedStoriesScreen';

const story = (o: Record<string, any>) => ({
    id: o.id ?? 's1',
    llmHeadline: o.llmHeadline ?? null,
    fallbackTitle: o.fallbackTitle ?? 'Fallback',
    latestTitle: o.latestTitle ?? null,
    unseenCount: o.unseenCount ?? 0,
    status: o.status ?? 'active',
    lastUpdateAt: o.lastUpdateAt ?? null,
    createdAt: o.createdAt ?? new Date(),
    ...o,
});

describe('TrackedStoriesScreen', () => {
    beforeEach(() => {
        mockRows = [];
        jest.clearAllMocks();
    });

    it('shows the empty state when no stories are followed', () => {
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        expect(getByText('trackedStories.emptyTitle')).toBeTruthy();
        expect(getByText('trackedStories.emptyBody')).toBeTruthy();
    });

    it('renders a row with headline, unseen badge and ended pill', () => {
        mockRows = [
            story({ id: 's1', llmHeadline: 'Flood update', unseenCount: 2 }),
            story({ id: 's2', fallbackTitle: 'Old story', status: 'ended', unseenCount: 0 }),
        ];
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        expect(getByText('Flood update')).toBeTruthy();
        // updatesBadge interpolates the count → "…updatesBadge:2".
        expect(getByText('trackedStories.updatesBadge:2')).toBeTruthy();
        expect(getByText('Old story')).toBeTruthy();
        expect(getByText('trackedStories.endedLabel')).toBeTruthy();
    });

    it('opens the timeline when a row is tapped', () => {
        mockRows = [story({ id: 's3', llmHeadline: 'Open me', unseenCount: 1 })];
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        fireEvent.press(getByText('Open me'));
        expect(router.push).toHaveBeenCalledWith(
            expect.objectContaining({
                pathname: '/logged-in/story-timeline',
                params: { trackedStoryId: 's3' },
            }),
        );
    });

    it('untracks after confirming the modal', () => {
        mockRows = [story({ id: 's4', llmHeadline: 'Drop me', unseenCount: 1 })];
        const { getByText, getByLabelText } = render(<TrackedStoriesScreen embedded />);
        // Long-press the row (labelled by its headline) opens the confirm modal.
        fireEvent(getByLabelText('Drop me'), 'longPress');
        // Confirm CTA — the only TEXT node reading untrackAction (the trash icon
        // carries it as an a11y label, not text).
        fireEvent.press(getByText('trackedStories.untrackAction'));
        expect(mockUntrack).toHaveBeenCalledWith('s4');
    });
});
