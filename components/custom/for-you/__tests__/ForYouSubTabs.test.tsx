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

// The Tabs primitive is mocked FUNCTIONALLY, not stubbed out: `TabsTrigger` has
// to actually invoke the root's `onValueChange` with its own `value`, otherwise
// the press assertions below would fail for the wrong reason (an inert trigger
// looks exactly like a broken migration). The real primitive drives selection
// through context + a horizontal FlatList, neither of which survives jest-expo's
// transform; this reproduces the contract, which is what the call site depends
// on. Reanimated/measurement behaviour is verified on the simulator instead.
jest.mock('@/components/ui/tabs', () => {
    const ReactLib = require('react');
    const { Pressable: RNPressable, Text: RNText, View: RNView } = require('react-native');
    const Ctx = ReactLib.createContext({});

    return {
        Tabs: ({ children, onValueChange, ...rest }: any) =>
            ReactLib.createElement(
                Ctx.Provider,
                { value: { onValueChange } },
                ReactLib.createElement(RNView, rest, children),
            ),
        TabsList: ({ children, ...rest }: any) => ReactLib.createElement(RNView, rest, children),
        TabsIndicator: () => null,
        TabsTrigger: ({ children, value, ...rest }: any) => {
            const { onValueChange } = ReactLib.useContext(Ctx);
            return ReactLib.createElement(
                RNPressable,
                { ...rest, onPress: () => onValueChange?.(value) },
                children,
            );
        },
        TabsTriggerText: ({ children, ...rest }: any) => ReactLib.createElement(RNText, rest, children),
    };
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

    it('renders a trigger per sub-tab', () => {
        const { getByText } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(getByText('forYou.subTabFeed')).toBeTruthy();
        expect(getByText('forYou.subTabStories')).toBeTruthy();
        expect(getByText('forYou.subTabSaved')).toBeTruthy();
        expect(getByText('forYou.subTabHistory')).toBeTruthy();
    });

    it('shows the unseen tracked-story badge on the Stories trigger', () => {
        const { getByText } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(getByText('3')).toBeTruthy();
    });

    it('hides the badge when there are no unseen stories', () => {
        mockEmitTotal = 0;
        const { queryByText } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(queryByText('0')).toBeNull();
    });

    it('fires onSelect with the tapped sub-tab', () => {
        const onSelect = jest.fn();
        const { getByText } = render(<ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />);
        fireEvent.press(getByText('forYou.subTabStories'));
        expect(onSelect).toHaveBeenCalledWith('stories');
    });

    it('fires onSelect with history when the History trigger is tapped', () => {
        const onSelect = jest.fn();
        const { getByText } = render(<ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />);
        fireEvent.press(getByText('forYou.subTabHistory'));
        expect(onSelect).toHaveBeenCalledWith('history');
    });

    it('marks the active trigger via accessibilityState', () => {
        const { getByLabelText } = render(<ForYouSubTabs activeSubTab="saved" onSelect={jest.fn()} />);
        expect(getByLabelText('forYou.subTabSaved').props.accessibilityState).toMatchObject({
            selected: true,
        });
    });

    it('keeps the row and every trigger testID for the simulator harness', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(getByTestId('dashboard-subtabs-row')).toBeTruthy();
        expect(getByTestId('dashboard-tab-feed')).toBeTruthy();
        expect(getByTestId('dashboard-tab-stories')).toBeTruthy();
        expect(getByTestId('dashboard-tab-saved')).toBeTruthy();
        expect(getByTestId('dashboard-tab-history')).toBeTruthy();
        expect(getByTestId('dashboard-tab-stories-badge')).toBeTruthy();
    });

    it('keeps the header row transparent to pull-to-refresh drags', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(getByTestId('dashboard-subtabs-row').props.pointerEvents).toBe('box-none');
    });
});
