// M9: the daily figure is grouped in the app language ("10,000", not "10000").
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { __esModule: true, GlassPanel: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });

import UsageWidget from '../UsageWidget';

it('groups the used and limit figures', () => {
    const r = render(<UsageWidget used={2330} limit={10000} usedLabel="analysed" />);
    expect(r.getByText(/2,330/)).toBeTruthy();
    expect(r.getByText(/10,000/)).toBeTruthy();
});

it('keeps the figure on one full-width line, above the plan row (C-PRO)', () => {
    const r = render(
        <UsageWidget
            used={1123}
            limit={10000}
            usedLabel="analysed"
            planLabel="Professional Plan"
            onUpgrade={() => {}}
            upgradeLabel="Manage plan"
        />,
    );
    expect(r.getByTestId('usage-widget-figure').props.numberOfLines).toBe(1);
    const order = r.UNSAFE_root
        .findAll((n: any) => typeof n.props?.children === 'string' && ['analysed', 'Professional Plan', 'Manage plan'].includes(n.props.children))
        .map((n: any) => n.props.children)
        .filter((c: string, i: number, all: string[]) => all.indexOf(c) === i);
    expect(order).toEqual(['analysed', 'Professional Plan', 'Manage plan']);
});
