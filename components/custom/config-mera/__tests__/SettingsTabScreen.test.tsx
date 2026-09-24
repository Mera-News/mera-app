/* eslint-disable @typescript-eslint/no-require-imports */
// Owner: "Settings (?)", the "?" right after the title as on every other tab.

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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 62, bottom: 83, left: 0, right: 0 }),
}));
jest.mock('@/lib/navigation/tab-bar', () => ({ useTabBarClearance: () => 83 }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => () => null);
jest.mock('../AppPreferencesTab', () => () => null);
jest.mock('@/components/custom/notifications/NotificationBellButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="bell" /> };
});
jest.mock('@/components/custom/for-you/TabExplainerButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID={p.testID} tab={p.tab} /> };
});
jest.mock('@/components/ui/heading', () => {
    const { Text } = require('react-native');
    return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
// jest-expo mis-transforms RN's ScrollView native-component file.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            return (target as any)[prop];
        },
    });
});

import SettingsTabScreen from '../SettingsTabScreen';

describe('SettingsTabScreen header', () => {
    it('puts the Settings explainer "?" right after the title', () => {
        const { UNSAFE_root, getByTestId } = render(<SettingsTabScreen />);
        const ids = UNSAFE_root
            .findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string')
            .map((n: any) => n.props.testID as string);
        const title = ids.indexOf('settings-title');
        expect(title).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('settings-explainer-open')).toBe(title + 1);
        expect(getByTestId('settings-explainer-open').props.tab).toBe('settings');
    });

    // Owner: "a notification icon in the right most of the row with the text
    // 'settings'".
    it('ends the title row with the shared bell, pinned to the title line height', () => {
        const { StyleSheet } = require('react-native');
        const r = render(<SettingsTabScreen />);
        const ids = r.UNSAFE_root
            .findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string')
            .map((n: any) => n.props.testID as string);
        expect(ids.indexOf('bell')).toBeGreaterThan(ids.indexOf('settings-explainer-open'));
        const cluster = StyleSheet.flatten(r.getByTestId('settings-header-actions').props.style);
        expect(cluster.height).toBe(54);
    });
});
