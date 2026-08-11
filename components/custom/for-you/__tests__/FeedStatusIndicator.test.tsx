/* eslint-disable @typescript-eslint/no-require-imports */
// The status glyph — one slot, three visible states, two invisible ones.
//
// What is actually worth asserting here is the INVISIBLE half. `idle` obviously
// draws nothing, but `deferred` is a deliberate call: it means "there are
// unscored rows and nothing is in flight", which the deleted bar rendered as a
// standing "waiting for the next batch (N)" line. That count is exactly the
// ambient pipeline chatter this screen is being cleared of, and a regression
// would put it back as a permanently-parked glyph next to the title.

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
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (props: any) => <View testID="status-spinner" {...props} /> };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View testID="status-glyph" {...props} /> };
});

import FeedStatusIndicator from '../FeedStatusIndicator';

const OPEN_A11Y = 'feedStatus.openA11y';
const COLLAPSE_A11Y = 'feedStatus.collapseA11y';
const TEST_ID = 'feed-status-indicator';

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

describe('FeedStatusIndicator', () => {
    it('renders a spinner while processing', () => {
        const { queryByTestId } = renderIndicator({ mode: 'processing' });
        expect(queryByTestId('status-spinner')).toBeTruthy();
        expect(queryByTestId('status-glyph')).toBeNull();
    });

    it('renders a red glyph on a scoring error', () => {
        const { queryByTestId } = renderIndicator({ mode: 'error' });
        expect(queryByTestId('status-spinner')).toBeNull();
        expect(queryByTestId('status-glyph')?.props.color).toBe('#F87171');
    });

    it('renders an amber glyph when daily-limited', () => {
        const { queryByTestId } = renderIndicator({ mode: 'limited' });
        expect(queryByTestId('status-glyph')?.props.color).toBe('#FBBF24');
    });

    it('renders nothing at all when idle', () => {
        const { queryByTestId } = renderIndicator({ mode: 'idle' });
        expect(queryByTestId(TEST_ID)).toBeNull();
    });

    it('renders nothing when rows are merely deferred', () => {
        // Deliberate: "waiting for the next batch" is a count the reader cannot
        // act on. It survives inside the detail panel, not as a header glyph.
        const { queryByTestId } = renderIndicator({ mode: 'deferred' });
        expect(queryByTestId(TEST_ID)).toBeNull();
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
