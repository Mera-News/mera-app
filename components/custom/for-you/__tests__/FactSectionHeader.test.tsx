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

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text: RNText } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <RNText>{text}</RNText> };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View {...props} /> };
});
jest.mock('@/components/custom/for-you/event-type-icons', () => ({
    eventTypeIcon: () => null,
}));

import FactSectionHeader from '../FactSectionHeader';

describe('FactSectionHeader', () => {
    // The "+N new" badge was REMOVED (owner: not necessary). The section's TOTAL
    // is the durable number, and it doubles as the CTA into the full panel.
    it('renders the total as the "N Articles" pill', () => {
        const { getByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        expect(getByText('forYou.articlesCount')).toBeTruthy();
    });

    it('no longer renders a "+N new" badge', () => {
        const { queryByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        expect(queryByText('+3')).toBeNull();
        expect(queryByText('+12')).toBeNull();
    });

    it('the pill opens the fact feed on tap', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(
            <FactSectionHeader title="Elections" eventType={null} total={5} onPress={onPress} />,
        );
        fireEvent.press(getByTestId('dashboard-section-pill'));
        expect(onPress).toHaveBeenCalled();
    });
});
