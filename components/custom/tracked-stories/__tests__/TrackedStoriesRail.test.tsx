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
    useTranslation: () => ({ t: (k: string) => k }),
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));

// jest-expo mis-transforms RN's ScrollView native component ("Unexpected token
// 'export'"). Proxy RN so ScrollView renders as a plain View.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            return (target as any)[prop];
        },
    });
});

// Drive the observable — each test seeds rows before rendering.
let mockRows: any[] = [];
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    observeActive: () => ({
        subscribe: (observer: any) => {
            observer.next(mockRows);
            return { unsubscribe: jest.fn() };
        },
    }),
}));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});

import { router } from 'expo-router';
import TrackedStoriesRail from '../TrackedStoriesRail';

const story = (o: Record<string, any>) => ({
    id: o.id ?? 's1',
    llmHeadline: o.llmHeadline ?? null,
    fallbackTitle: o.fallbackTitle ?? 'Fallback title',
    unseenCount: o.unseenCount ?? 0,
    ...o,
});

describe('TrackedStoriesRail', () => {
    beforeEach(() => {
        mockRows = [];
        jest.clearAllMocks();
    });

    it('renders nothing when no active story has unseen developments', () => {
        mockRows = [story({ id: 's1', unseenCount: 0 })];
        const { queryByText } = render(<TrackedStoriesRail />);
        expect(queryByText('trackedStories.railTitle')).toBeNull();
    });

    it('renders a chip per unseen story with its headline and count', () => {
        mockRows = [
            story({ id: 's1', llmHeadline: 'War talks resume', unseenCount: 3 }),
            story({ id: 's2', fallbackTitle: 'Quiet story', unseenCount: 0 }),
        ];
        const { getByText, queryByText } = render(<TrackedStoriesRail />);
        expect(getByText('trackedStories.railTitle')).toBeTruthy();
        expect(getByText('War talks resume')).toBeTruthy();
        expect(getByText('3')).toBeTruthy();
        // The seen story earns no chip.
        expect(queryByText('Quiet story')).toBeNull();
    });

    it('opens the timeline when a chip is tapped', () => {
        mockRows = [story({ id: 's7', llmHeadline: 'Tap me', unseenCount: 1 })];
        const { getByText } = render(<TrackedStoriesRail />);
        fireEvent.press(getByText('Tap me'));
        expect(router.push).toHaveBeenCalledWith(
            expect.objectContaining({
                pathname: '/logged-in/story-timeline',
                params: { trackedStoryId: 's7' },
            }),
        );
    });
});
