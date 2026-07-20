/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

// Emit a fixed unseen total synchronously on subscribe.
let mockEmitTotal = 3;
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    observeUnseenTotal: () => ({
        subscribe: (observer: any) => {
            observer.next(mockEmitTotal);
            return { unsubscribe: jest.fn() };
        },
    }),
}));

jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View {...props} /> };
});

import ForYouSubTabs from '../ForYouSubTabs';

describe('ForYouSubTabs', () => {
    beforeEach(() => {
        mockEmitTotal = 3;
    });

    it('renders a pill per sub-tab', () => {
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        expect(getByText('forYou.subTabFeed')).toBeTruthy();
        expect(getByText('forYou.subTabStories')).toBeTruthy();
        expect(getByText('forYou.subTabSaved')).toBeTruthy();
    });

    it('shows the unseen tracked-story badge on the Stories pill', () => {
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        expect(getByText('3')).toBeTruthy();
    });

    it('hides the badge when there are no unseen stories', () => {
        mockEmitTotal = 0;
        const { queryByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        expect(queryByText('0')).toBeNull();
    });

    it('fires onSelect with the tapped sub-tab', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />,
        );
        fireEvent.press(getByText('forYou.subTabStories'));
        expect(onSelect).toHaveBeenCalledWith('stories');
    });

    it('marks the active pill via accessibilityState', () => {
        const { getByLabelText } = render(
            <ForYouSubTabs activeSubTab="saved" onSelect={jest.fn()} />,
        );
        expect(getByLabelText('forYou.subTabSaved').props.accessibilityState).toMatchObject({
            selected: true,
        });
    });
});
