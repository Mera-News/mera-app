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
    it('renders a "+N" pill when newCount > 0', () => {
        const { getByText, getByLabelText } = render(
            <FactSectionHeader title="Elections" eventType={null} newCount={3} onPress={jest.fn()} />,
        );
        expect(getByText('+3')).toBeTruthy();
        // a11y label uses the pluralized i18n key.
        expect(getByLabelText('forYou.newInSection')).toBeTruthy();
    });

    it('caps the pill display at "+99"', () => {
        const { getByText } = render(
            <FactSectionHeader title="Elections" eventType={null} newCount={250} onPress={jest.fn()} />,
        );
        expect(getByText('+99')).toBeTruthy();
    });

    it('hides the pill when newCount is 0', () => {
        const { queryByLabelText } = render(
            <FactSectionHeader title="Elections" eventType={null} newCount={0} onPress={jest.fn()} />,
        );
        expect(queryByLabelText('forYou.newInSection')).toBeNull();
    });

    it('is pressable — opens the fact feed on tap', () => {
        const onPress = jest.fn();
        const { getByLabelText } = render(
            <FactSectionHeader title="Elections" eventType={null} onPress={onPress} />,
        );
        const pressable = getByLabelText('forYou.openFactFeed');
        fireEvent.press(pressable);
        expect(onPress).toHaveBeenCalled();
    });
});
