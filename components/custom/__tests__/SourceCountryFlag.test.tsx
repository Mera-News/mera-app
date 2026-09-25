// ux2 B4 (owner): on the article detail page, the country name in the flag's
// popover opens that country's publication list, the same route the Sources
// list uses.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}::${JSON.stringify(o)}` : k) }),
}));
jest.mock('@/components/custom/SourceFlag', () => ({ SourceFlag: () => null }));
jest.mock('@/lib/country-utils', () => ({ getCountryName: (c: string) => (c === 'NLD' ? 'Netherlands' : c) }));
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
// The popover renders its trigger always and its content only while open.
jest.mock('@/components/ui/popover', () => {
    const { View } = require('react-native');
    return {
        Popover: ({ isOpen, trigger, children }: any) => (
            <View>
                {trigger({})}
                {isOpen ? children : null}
            </View>
        ),
        PopoverBackdrop: () => null,
        PopoverBody: ({ children }: any) => <View>{children}</View>,
        PopoverContent: ({ children }: any) => <View>{children}</View>,
    };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a) } }));

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { SourceCountryFlag } from '../SourceCountryFlag';

beforeEach(() => mockPush.mockClear());

it('tapping the country name opens that country\'s publication list and closes the popover', () => {
    const r = render(<SourceCountryFlag countryCode="NLD" />);
    fireEvent.press(r.getByLabelText('articleDetail.sourceCountryA11y::{"country":"Netherlands"}'));
    const link = r.getByTestId('source-country-link');
    expect(link.props.accessibilityRole).toBe('link');
    fireEvent.press(link);
    expect(mockPush).toHaveBeenCalledWith({
        pathname: '/logged-in/sources-publishers',
        params: { countryCode: 'NLD', countryName: 'Netherlands' },
    });
    expect(r.queryByTestId('source-country-link')).toBeNull();
});

it('Global opens the Global list', () => {
    const r = render(<SourceCountryFlag countryCode="GLOBAL" />);
    fireEvent.press(r.getByLabelText('articleDetail.sourceCountryA11y::{"country":"articleDetail.sourceCountryGlobal"}'));
    fireEvent.press(r.getByTestId('source-country-link'));
    expect(mockPush).toHaveBeenCalledWith({
        pathname: '/logged-in/sources-publishers',
        params: { countryCode: 'GLOBAL', countryName: 'articleDetail.sourceCountryGlobal' },
    });
});
