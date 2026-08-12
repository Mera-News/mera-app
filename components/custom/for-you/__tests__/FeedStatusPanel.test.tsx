/* eslint-disable @typescript-eslint/no-require-imports */
// The detail panel. Ports the assertions that survived FeedStatusShimmer's
// deletion — the "Analysing X of Y" line and its absence without a batch total —
// plus the two the split introduced: the panel is mounted only when open, and
// the processing-only lines do not leak into an error/limited panel.

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

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const anim = { duration: () => anim };
    return {
        __esModule: true,
        default: { View: (props: any) => <View {...props} /> },
        FadeIn: anim,
        FadeOut: anim,
        LinearTransition: {},
    };
});

jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: (props: any) => <RNText {...props} /> };
});
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { GlassPanel: (props: any) => <View {...props} /> };
});

// The counts + phase selectors are stubbed so this stays isolated from the real
// zustand store; the detail body has its own tests and the sheet's.
let mockBatchProgress: { done: number; total: number } | null = null;
jest.mock('@/lib/stores/selectors', () => ({
    useForYouAsyncJobPhase: () => 'idle',
    useForYouBatchProgress: () => mockBatchProgress,
    useForYouDeviceProcessing: () => ({
        isDeviceProcessing: false,
        deviceProcessedCount: 0,
        deviceTotalCount: 0,
    }),
}));
jest.mock('@/lib/hooks/use-feed-counts', () => ({
    useFeedCounts: () => ({
        articleCount: 12,
        analysedCount: 8,
        relevantCount: 3,
        readCount: 1,
    }),
}));
jest.mock('../FeedStatusDetails', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="feed-status-details" /> };
});

import FeedStatusPanel from '../FeedStatusPanel';

beforeEach(() => {
    mockBatchProgress = null;
});

describe('FeedStatusPanel', () => {
    it('renders nothing while collapsed', () => {
        const { queryByTestId } = render(<FeedStatusPanel expanded={false} mode="processing" />);
        expect(queryByTestId('feed-status-details')).toBeNull();
    });

    it('renders the detail body when expanded', () => {
        const { queryByTestId } = render(<FeedStatusPanel expanded mode="processing" />);
        expect(queryByTestId('feed-status-details')).toBeTruthy();
        // The harness and the old accordion both key off this id.
        expect(queryByTestId('dashboard-status-details-panel')).toBeTruthy();
    });

    it('shows the "Analysing X of Y articles" progress line while processing', () => {
        mockBatchProgress = { done: 3, total: 10 };
        const { getByText } = render(<FeedStatusPanel expanded mode="processing" />);
        expect(getByText('feed.analysingProgress')).toBeTruthy();
    });

    it('omits the progress line when there is no batch total', () => {
        mockBatchProgress = null;
        const { queryByText } = render(<FeedStatusPanel expanded mode="processing" />);
        expect(queryByText('feed.analysingProgress')).toBeNull();
    });

    it('does not show processing-only lines in an error panel', () => {
        mockBatchProgress = { done: 3, total: 10 };
        const { queryByText, queryByTestId } = render(<FeedStatusPanel expanded mode="error" />);
        expect(queryByTestId('feed-status-details')).toBeTruthy();
        expect(queryByText('feed.analysingProgress')).toBeNull();
    });
});
