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
    // The header's open affordance is now an ICON-ONLY round arrow — the count
    // moved to the section's closing "View all N articles" row so it isn't shown
    // twice. Icon-only means the label is the only thing VoiceOver can announce,
    // so it must still name the destination AND the count.
    it('renders a round open button labelled with the destination and count', () => {
        const { getByTestId } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        const btn = getByTestId('dashboard-section-open');
        expect(btn.props.accessibilityLabel).toBe('forYou.viewAllArticles');
        expect(btn.props.accessibilityRole).toBe('button');
    });

    it('no longer draws the article count in the header', () => {
        const { queryByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        expect(queryByText('forYou.articlesCount')).toBeNull();
        expect(queryByText('12')).toBeNull();
    });

    it('no longer renders a "+N new" badge', () => {
        const { queryByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        expect(queryByText('+3')).toBeNull();
        expect(queryByText('+12')).toBeNull();
    });

    // Headline sections (P5) reuse this header with two opt-outs: they are not
    // "News about:" anything, and their title is app copy already in the
    // reader's language.
    it('renders the "News about:" prefix by default', () => {
        const { getByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={5} onPress={jest.fn()} />,
        );
        expect(getByText('forYou.sectionPrefix')).toBeTruthy();
    });

    it('omits the prefix row entirely when prefix is null', () => {
        const { queryByText, getByText } = render(
            <FactSectionHeader
                title="Around the world"
                eventType={null}
                total={5}
                onPress={jest.fn()}
                prefix={null}
                translateTitle={false}
            />,
        );
        expect(queryByText('forYou.sectionPrefix')).toBeNull();
        expect(getByText('Around the world')).toBeTruthy();
    });

    it('renders no open affordance for a section with no destination', () => {
        const { queryByTestId } = render(
            <FactSectionHeader title="Around the world" eventType={null} total={0} prefix={null} />,
        );
        expect(queryByTestId('dashboard-section-open')).toBeNull();
    });

    it('the round button opens the fact feed on tap', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(
            <FactSectionHeader title="Elections" eventType={null} total={5} onPress={onPress} />,
        );
        fireEvent.press(getByTestId('dashboard-section-open'));
        expect(onPress).toHaveBeenCalled();
    });
});
