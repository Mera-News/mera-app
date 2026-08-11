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

// jest-expo mis-transforms RN's ScrollView native-component file ("Unexpected
// token 'export'") — same trap documented in AddLocationView.test.tsx /
// ScopeChipRow.test.tsx. Proxy RN so ScrollView renders as a plain View; every
// other export stays lazy/real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return StubScrollView;
            }
            return (target as any)[prop];
        },
    });
});

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
        expect(getByText('forYou.subTabHistory')).toBeTruthy();
        expect(getByText('factCheck.dashboard.title')).toBeTruthy();
    });

    // Position is the requirement, not just presence: "after History".
    it('places Fact checks LAST, immediately after History', () => {
        const { getByTestId } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        const row = getByTestId('dashboard-subtabs-row');
        const keys: string[] = [];
        const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            const id = node.props?.testID;
            if (typeof id === 'string' && /^dashboard-tab-[a-zA-Z]+$/.test(id)) {
                keys.push(id.replace('dashboard-tab-', ''));
            }
            React.Children.forEach(node.props?.children, walk);
        };
        walk(row);
        expect(keys).toEqual(['feed', 'stories', 'saved', 'history', 'factChecks']);
    });

    it('fires onSelect with factChecks when the Fact checks pill is tapped', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />,
        );
        fireEvent.press(getByText('factCheck.dashboard.title'));
        expect(onSelect).toHaveBeenCalledWith('factChecks');
    });

    it('marks the Fact checks pill active like any other', () => {
        const { getByLabelText } = render(
            <ForYouSubTabs activeSubTab="factChecks" onSelect={jest.fn()} />,
        );
        expect(
            getByLabelText('factCheck.dashboard.title').props.accessibilityState,
        ).toMatchObject({ selected: true });
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

    it('fires onSelect with history when the History pill is tapped', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />,
        );
        fireEvent.press(getByText('forYou.subTabHistory'));
        expect(onSelect).toHaveBeenCalledWith('history');
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
