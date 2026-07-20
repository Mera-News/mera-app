/* eslint-disable @typescript-eslint/no-require-imports */
import { render } from '@testing-library/react-native';
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
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View {...props} /> };
});

import CaughtUpDivider from '../CaughtUpDivider';

describe('CaughtUpDivider', () => {
    it('renders the caught-up marker, hint, and Earlier count for the normal variant', () => {
        const { getByText, queryByText } = render(
            <CaughtUpDivider variant="normal" earlierCount={7} />,
        );
        expect(getByText('forYou.caughtUp')).toBeTruthy();
        expect(queryByText('forYou.caughtUpHint')).toBeTruthy();
        expect(getByText('forYou.earlier')).toBeTruthy();
        expect(getByText('7')).toBeTruthy();
    });

    it('omits the hint for the empty-new variant (nothing new above)', () => {
        const { getByText, queryByText } = render(
            <CaughtUpDivider variant="empty-new" earlierCount={3} />,
        );
        expect(getByText('forYou.caughtUp')).toBeTruthy();
        expect(queryByText('forYou.caughtUpHint')).toBeNull();
        expect(getByText('forYou.earlier')).toBeTruthy();
        expect(getByText('3')).toBeTruthy();
    });
});
