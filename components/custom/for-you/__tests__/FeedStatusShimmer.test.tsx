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
    const anim = { duration: () => anim };
    return {
        __esModule: true,
        default: { View: (props: any) => <View {...props} /> },
        useSharedValue: (v: number) => ({ value: v }),
        useAnimatedStyle: () => ({}),
        withRepeat: (v: unknown) => v,
        withTiming: (v: unknown) => v,
        Easing: { inOut: (fn: unknown) => fn, ease: (v: unknown) => v },
        FadeIn: anim,
        FadeOut: anim,
        LinearTransition: {},
    };
});

jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: (props: any) => <RNText {...props} /> };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View {...props} /> };
});

// FeedStatusShimmer's collapsed-row cycling headline reads the fact-stage +
// async-job-phase selectors directly (Round-3 B2) — stub them to the "no run
// active" defaults so this test stays isolated from the real zustand store.
jest.mock('@/lib/stores/selectors', () => ({
    useForYouAsyncJobPhase: () => 'idle',
    useForYouFactStages: () => [],
}));

// The inline detail body is exercised by its own tests + the sheet; here it is
// stubbed so the shimmer test stays isolated from the store selectors.
jest.mock('../FeedStatusDetails', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="feed-status-details" /> };
});

import FeedStatusShimmer from '../FeedStatusShimmer';

const OPEN_A11Y = 'feedStatus.openA11y';
const EXPAND_A11Y = 'feedStatus.expandA11y';
const COLLAPSE_A11Y = 'feedStatus.collapseA11y';

const detailProps = {
    processedCount: 0,
    analysedCount: 0,
    relevantCount: 0,
    noiseRemovedCount: 0,
    injectNoiseEnabled: false,
    lastProcessedLabel: null,
};

describe('FeedStatusShimmer', () => {
    it('renders a tappable bar + collapsed expand chevron while processing', () => {
        const { getByLabelText, queryByTestId } = render(
            <FeedStatusShimmer processing error={false} dailyLimited={false} {...detailProps} />,
        );
        expect(getByLabelText(OPEN_A11Y)).toBeTruthy();
        expect(getByLabelText(EXPAND_A11Y)).toBeTruthy();
        // Collapsed by default — the detail panel is not mounted.
        expect(queryByTestId('feed-status-details')).toBeNull();
    });

    it('expands the inline detail panel when the chevron is tapped, and collapses again', () => {
        const { getByLabelText, queryByTestId } = render(
            <FeedStatusShimmer processing error={false} dailyLimited={false} {...detailProps} />,
        );
        fireEvent.press(getByLabelText(EXPAND_A11Y));
        expect(queryByTestId('feed-status-details')).toBeTruthy();
        // The chevron now advertises collapse; tapping it hides the panel.
        fireEvent.press(getByLabelText(COLLAPSE_A11Y));
        expect(queryByTestId('feed-status-details')).toBeNull();
    });

    it('tapping the bar itself also toggles the panel', () => {
        const { getByLabelText, queryByTestId } = render(
            <FeedStatusShimmer processing error={false} dailyLimited={false} {...detailProps} />,
        );
        fireEvent.press(getByLabelText(OPEN_A11Y));
        expect(queryByTestId('feed-status-details')).toBeTruthy();
    });

    it('renders a static bar on a scoring error (not processing)', () => {
        const { getByLabelText } = render(
            <FeedStatusShimmer processing={false} error dailyLimited={false} {...detailProps} />,
        );
        expect(getByLabelText(OPEN_A11Y)).toBeTruthy();
    });

    it('renders a static bar when daily-limited (not processing)', () => {
        const { getByLabelText } = render(
            <FeedStatusShimmer processing={false} error={false} dailyLimited {...detailProps} />,
        );
        expect(getByLabelText(OPEN_A11Y)).toBeTruthy();
    });

    it('renders nothing when idle', () => {
        const { queryByLabelText } = render(
            <FeedStatusShimmer processing={false} error={false} dailyLimited={false} {...detailProps} />,
        );
        expect(queryByLabelText(OPEN_A11Y)).toBeNull();
    });
});
