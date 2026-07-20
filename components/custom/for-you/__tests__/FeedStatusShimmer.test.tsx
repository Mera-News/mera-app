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

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: { View: (props: any) => <View {...props} /> },
        useSharedValue: (v: number) => ({ value: v }),
        useAnimatedStyle: () => ({}),
        withRepeat: (v: unknown) => v,
        withTiming: (v: unknown) => v,
        Easing: { inOut: (fn: unknown) => fn, ease: (v: unknown) => v },
    };
});

jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});

import FeedStatusShimmer from '../FeedStatusShimmer';

const A11Y = 'feedStatus.openA11y';

describe('FeedStatusShimmer', () => {
    it('renders a tappable bar while processing', () => {
        const onPress = jest.fn();
        const { getByLabelText } = render(
            <FeedStatusShimmer processing error={false} dailyLimited={false} onPress={onPress} />,
        );
        const bar = getByLabelText(A11Y);
        expect(bar).toBeTruthy();
        fireEvent.press(bar);
        expect(onPress).toHaveBeenCalled();
    });

    it('renders a static bar on a scoring error (not processing)', () => {
        const { getByLabelText } = render(
            <FeedStatusShimmer processing={false} error dailyLimited={false} onPress={jest.fn()} />,
        );
        expect(getByLabelText(A11Y)).toBeTruthy();
    });

    it('renders a static bar when daily-limited (not processing)', () => {
        const { getByLabelText } = render(
            <FeedStatusShimmer processing={false} error={false} dailyLimited onPress={jest.fn()} />,
        );
        expect(getByLabelText(A11Y)).toBeTruthy();
    });

    it('renders nothing when idle', () => {
        const { queryByLabelText } = render(
            <FeedStatusShimmer processing={false} error={false} dailyLimited={false} onPress={jest.fn()} />,
        );
        expect(queryByLabelText(A11Y)).toBeNull();
    });
});
