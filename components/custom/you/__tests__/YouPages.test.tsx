/* eslint-disable @typescript-eslint/no-require-imports */
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
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: { ScrollView: (p: any) => <View {...p} /> } };
});
jest.mock('@/lib/navigation/tab-bar', () => ({ useTabBarClearance: () => 0 }));
const mockSetPageOrder = jest.fn();
jest.mock('@/lib/navigation/page-order', () => ({
    usePageOrder: () => ['settings', 'profile'],
    setPageOrder: (...a: unknown[]) => mockSetPageOrder(...a),
}));
jest.mock('@/components/custom/nav/page-registry', () => ({
    pageMeta: (id: string) => ({ labelKey: `tabs.${id}` }),
}));
let mockTabProps: any;
jest.mock('@/components/custom/nav/TabPages', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => {
            mockTabProps = p;
            const header = { scrollHandler: undefined, headerHeight: 0 };
            return <View>{p.pages.map((pill: any) => <View key={pill.id}>{p.renderPage({ pageId: pill.id, active: true, header, params: null })}</View>)}</View>;
        },
    };
});
jest.mock('@/components/custom/config-mera/AppPreferencesTab', () => { const { Text } = require('react-native'); return { __esModule: true, default: () => <Text>settings-list</Text> }; });
jest.mock('../ProfileHub', () => { const { Text } = require('react-native'); return { __esModule: true, default: () => <Text>profile-hub</Text> }; });

import YouPages from '../YouPages';

it('renders Profile and Settings in the reader order, with the bell', () => {
    const r = render(<YouPages />);
    expect(mockTabProps.tab).toBe('you');
    expect(mockTabProps.trailing).toBe('bell');
    expect(mockTabProps.pages.map((p: any) => [p.id, p.label])).toEqual([
        ['settings', 'tabs.settings'],
        ['profile', 'tabs.profile'],
    ]);
    expect(r.getByText('profile-hub')).toBeTruthy();
    expect(r.getByText('settings-list')).toBeTruthy();
});

it('saves a rearranged order for the You tab', () => {
    render(<YouPages />);
    mockTabProps.arrange.onSave({ order: ['profile', 'settings'], removed: [], added: [] });
    expect(mockSetPageOrder).toHaveBeenCalledWith('you', ['profile', 'settings']);
});
