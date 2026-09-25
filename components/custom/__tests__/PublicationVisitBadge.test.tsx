// PublicationVisitBadge: the tooltip's "see history" link must be reachable by
// VoiceOver (ux2). Gluestack portals popover content to the app root, outside
// the native screen, so the bubble was not in the accessibility tree; and the
// link was a nested Text with onPress, which iOS does not expose on its own.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/ui/popover', () => {
    const { View } = require('react-native');
    return {
        Popover: ({ isOpen, trigger, children, useRNModal }: any) => (
            <View testID="popover" {...{ useRNModal }}>
                {trigger({})}
                {isOpen ? children : null}
            </View>
        ),
        PopoverArrow: () => null,
        PopoverBackdrop: () => null,
        PopoverBody: ({ children, ...p }: any) => <View {...p}>{children}</View>,
        PopoverContent: ({ children }: any) => <View>{children}</View>,
    };
});
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getVisitCountForPublication: jest.fn(async () => 3),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a) } }));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import PublicationVisitBadge from '../PublicationVisitBadge';

beforeEach(() => mockPush.mockClear());

async function openBadge() {
    const r = render(<PublicationVisitBadge publicationName="NOS" countryCode="NLD" />);
    await waitFor(() => expect(r.getByLabelText('publicationVisits.tooltipA11y')).toBeTruthy());
    fireEvent.press(r.getByLabelText('publicationVisits.tooltipA11y'));
    return r;
}

it('presents its bubble in a native modal', async () => {
    const r = render(<PublicationVisitBadge publicationName="NOS" countryCode="NLD" />);
    await waitFor(() => expect(r.getByTestId('popover')).toBeTruthy());
    expect(r.getByTestId('popover').props.useRNModal).toBe(true);
});

it('the history link is ONE accessible element, a link, that opens the history', async () => {
    const r = await openBadge();
    const link = r.getByRole('link');
    expect(link.props.accessibilityLabel).toContain('publicationVisits.tooltipLink');
    fireEvent.press(link);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/logged-in/visited-publications' });
});

it('the VoiceOver escape gesture closes the bubble', async () => {
    const r = await openBadge();
    fireEvent(r.getByTestId('publication-visit-bubble'), 'accessibilityEscape');
    expect(r.queryByRole('link')).toBeNull();
});
