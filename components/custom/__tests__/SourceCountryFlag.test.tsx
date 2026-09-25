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
        Popover: ({ isOpen, trigger, children, useRNModal }: any) => (
            <View testID="popover" {...{ useRNModal }}>
                {trigger({})}
                {isOpen ? children : null}
            </View>
        ),
        PopoverBackdrop: () => null,
        PopoverBody: ({ children, ...p }: any) => <View {...p}>{children}</View>,
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

// ux2: VoiceOver could not reach the bubble. Gluestack portals popover content
// to the app root, outside the native screen the detail page lives in, so the
// link was not in the accessibility tree. In an RN Modal it is on top, and
// VoiceOver moves into it.
describe('the open bubble is reachable by VoiceOver', () => {
    it('presents in a native modal', () => {
        const r = render(<SourceCountryFlag countryCode="NLD" />);
        expect(r.getByTestId('popover').props.useRNModal).toBe(true);
    });

    it('its link is one accessible element: role link, label the country name', () => {
        const r = render(<SourceCountryFlag countryCode="NLD" />);
        fireEvent.press(r.getByLabelText('articleDetail.sourceCountryA11y::{"country":"Netherlands"}'));
        const link = r.getByRole('link', { name: 'Netherlands' });
        expect(link.props.accessible).not.toBe(false);
        expect(link.props.accessibilityLabel).toBe('Netherlands');
    });

    it('the VoiceOver escape gesture closes it', () => {
        const r = render(<SourceCountryFlag countryCode="NLD" />);
        fireEvent.press(r.getByLabelText('articleDetail.sourceCountryA11y::{"country":"Netherlands"}'));
        const escapable = r.getByTestId('source-country-bubble');
        fireEvent(escapable, 'accessibilityEscape');
        expect(r.queryByTestId('source-country-link')).toBeNull();
    });
});
