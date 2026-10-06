/* eslint-disable react/display-name, @typescript-eslint/no-require-imports */
// D2: every tab bar item carries a real accessibility label. VoiceOver read the
// SF Symbol names ("grid 2x2", "safari") because a hidden <Label> is not used
// as the item's label.
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
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/components/custom/ModelDownloadBanner', () => ({ __esModule: true, default: () => null }));
const mockTriggers: Record<string, any> = {};
jest.mock('expo-router/unstable-native-tabs', () => {
    const NativeTabs: any = ({ children }: any) => children;
    NativeTabs.Trigger = (p: any) => {
        mockTriggers[p.name] = p;
        return null;
    };
    NativeTabs.Trigger.Icon = () => null;
    NativeTabs.Trigger.Label = () => null;
    NativeTabs.Trigger.VectorIcon = () => null;
    return { NativeTabs };
});

import AppLayout from '../logged-in/app_container/_layout';

it('labels every tab item for VoiceOver', () => {
    render(<AppLayout />);
    const labels = Object.fromEntries(
        Object.entries(mockTriggers).map(([name, p]) => [name, p.unstable_nativeProps?.tabBarItemAccessibilityLabel]),
    );
    expect(labels).toEqual({
        feed: 'tabs.deck',
        world: 'tabs.world',
        library: 'tabs.library',
        you: 'tabs.you',
        for_you: 'tabs.dashboard',
        around: 'tabs.around',
        profile: 'tabs.profile',
        settings: 'tabs.settings',
    });
});

it('orders the four tabs Feed, World, Library, You, ahead of the old ones', () => {
    render(<AppLayout />);
    expect(Object.keys(mockTriggers).slice(0, 4)).toEqual(['feed', 'world', 'library', 'you']);
});

it('leaves pop-to-root on for the four tabs, and scroll-to-top to JS', () => {
    render(<AppLayout />);
    for (const name of ['feed', 'world', 'library', 'you']) {
        expect(mockTriggers[name].disablePopToTop).toBeFalsy();
        expect(mockTriggers[name].disableScrollToTop).toBe(true);
    }
});
