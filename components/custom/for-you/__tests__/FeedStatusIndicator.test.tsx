/* eslint-disable @typescript-eslint/no-require-imports */
// The status mark — one slot, five states, and it is NEVER absent.
//
// The thing worth pinning here is that last clause. This component used to
// return null for `idle` and `deferred`, which meant the header changed shape at
// the end of every single sync and the detail panel behind the mark could only
// be opened while one happened to be running. Both regressions look like nothing
// in a screenshot, so `idle` and `deferred` get explicit "renders AND is
// tappable" tests rather than being treated as the boring cases.
//
// The rest is the state→appearance table, which is entirely carried by props
// handed to MeraLogo (colour, `animated`) plus the wrapper's scale. Mocking
// MeraLogo keeps react-native-svg out of this suite and turns that table into
// direct prop assertions.

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

jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/custom/MeraLogo', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="mera-logo" {...p} /> };
});
// `useAnimatedStyle` runs its worklet at render time here, so the style the
// wrapper receives is whatever the shared value holds on THAT render — which is
// the seed the component derived from `mode`. That is what makes the scale
// assertions below meaningful; they pin the resting size per mode, not the
// withTiming transition between two of them.
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: { View: (p: any) => <View {...p} /> },
        useSharedValue: (initial: unknown) => ({ value: initial }),
        useAnimatedStyle: (fn: () => unknown) => fn(),
        withTiming: (v: unknown) => v,
    };
});

import FeedStatusIndicator from '../FeedStatusIndicator';

const OPEN_A11Y = 'feedStatus.openA11y';
const COLLAPSE_A11Y = 'feedStatus.collapseA11y';
const TEST_ID = 'feed-status-indicator';
const MARK_ID = `${TEST_ID}-mark`;

const ACTIVE = '#FFFFFF';
/** tailwind.config.js `light`. */
const RESTING = '#FBFBFB';

function renderIndicator(overrides: Partial<React.ComponentProps<typeof FeedStatusIndicator>> = {}) {
    return render(
        <FeedStatusIndicator
            mode="processing"
            expanded={false}
            onPress={jest.fn()}
            testID={TEST_ID}
            {...overrides}
        />,
    );
}

/** The scale factor the wrapper is actually carrying, flattened out of whatever
 *  shape the transform array arrived in. */
function scaleOf(node: any): number | undefined {
    const transform = node?.props?.style?.transform;
    return transform?.find((e: any) => 'scale' in e)?.scale;
}

describe('FeedStatusIndicator', () => {
    it('sweeps the mark, enlarged and pure white, while processing', () => {
        const { getByTestId } = renderIndicator({ mode: 'processing' });
        expect(getByTestId('mera-logo').props.animated).toBe(true);
        expect(getByTestId('mera-logo').props.color).toBe(ACTIVE);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1.3);
    });

    it('renders a red mark on a scoring error', () => {
        const { getByTestId } = renderIndicator({ mode: 'error' });
        expect(getByTestId('mera-logo').props.color).toBe('#F87171');
        expect(getByTestId('mera-logo').props.animated).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1);
    });

    it('renders an amber mark when daily-limited', () => {
        const { getByTestId } = renderIndicator({ mode: 'limited' });
        expect(getByTestId('mera-logo').props.color).toBe('#FBBF24');
        expect(getByTestId('mera-logo').props.animated).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1);
    });

    it('still renders a still, off-white, tappable mark when idle', () => {
        // The whole point of the change: this used to return null, so the panel
        // was unreachable on the screen state the user spends most of their time
        // in and the header visibly resized every time a sync ended.
        const onPress = jest.fn();
        const { getByTestId } = renderIndicator({ mode: 'idle', onPress });
        expect(getByTestId('mera-logo').props.color).toBe(RESTING);
        expect(getByTestId('mera-logo').props.animated).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1);

        fireEvent.press(getByTestId(TEST_ID));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('still renders a still, off-white, tappable mark when rows are merely deferred', () => {
        // `deferred` gets no colour or motion of its own: "waiting for the next
        // batch (N)" is a pipeline count the reader cannot act on, and giving it
        // a distinct look would put the deleted status bar's chatter back. It is
        // still reachable, because the count lives inside the panel this opens.
        const onPress = jest.fn();
        const { getByTestId } = renderIndicator({ mode: 'deferred', onPress });
        expect(getByTestId('mera-logo').props.color).toBe(RESTING);
        expect(getByTestId('mera-logo').props.animated).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1);

        fireEvent.press(getByTestId(TEST_ID));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('animates the sweep in processing and in no other state', () => {
        // One assertion over the whole enum, so a new mode cannot quietly start
        // re-rasterising an SVG on the CPU behind a header that is at rest.
        const modes = ['processing', 'error', 'limited', 'deferred', 'idle'] as const;
        const animatedIn = modes.filter(
            (mode) => renderIndicator({ mode }).getByTestId('mera-logo').props.animated === true,
        );
        expect(animatedIn).toEqual(['processing']);
    });

    it('calls onPress when tapped', () => {
        const onPress = jest.fn();
        const { getByTestId } = renderIndicator({ onPress });
        fireEvent.press(getByTestId(TEST_ID));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('advertises open vs collapse to screen readers', () => {
        const { queryByLabelText, rerender } = renderIndicator({ expanded: false });
        expect(queryByLabelText(OPEN_A11Y)).toBeTruthy();

        rerender(
            <FeedStatusIndicator mode="processing" expanded onPress={jest.fn()} testID={TEST_ID} />,
        );
        expect(queryByLabelText(COLLAPSE_A11Y)).toBeTruthy();
    });
});
