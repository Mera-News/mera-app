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
        useReducedMotion: () => false,
    };
});

// `useProcessingSnapshot` reaches FeedSyncIndicator, which imports AppScheduler
// and with it `lib/database/index.ts` — that module builds a real SQLiteAdapter
// at import time and throws `initializeJSI` outside a native runtime. Stubbing
// the indicator is the narrowest cut that keeps the snapshot hook itself real.
jest.mock('@/components/custom/FeedSyncIndicator', () => ({
    useFeedSyncRunning: () => false,
    useIsFeedProcessing: () => false,
}));

// Same reason, second path in: the prefs store imports `setting-service`, which
// imports the same database module.
jest.mock('@/lib/stores/display-prefs-store', () => ({
    useDisplayPrefsStore: (sel: any) => sel({ staticGradient: false }),
}));

jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: (props: any) => <RNText {...props} /> };
});
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return {
        GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
        GlassPanel: (props: any) => <View {...props} />,
    };
});

// The counts + phase selectors are stubbed so this stays isolated from the real
// zustand store; the detail body has its own tests and the sheet's.
let mockBatchProgress: { done: number; total: number } | null = null;
jest.mock('@/lib/stores/selectors', () => ({
    useForYouAsyncJobPhase: () => 'idle',
    useForYouAsyncJobProcessedCount: () => 30,
    useForYouAsyncJobTotalCount: () => 36,
    useForYouBatchProgress: () => mockBatchProgress,
    useForYouDeviceProcessing: () => ({
        isDeviceProcessing: false,
        deviceProcessedCount: 0,
        deviceTotalCount: 0,
    }),
    // `useProcessingSnapshot` reads five more selectors than this panel does
    // directly. They are stubbed at rest: this file tests which lines the panel
    // shows per mode, and the snapshot's own stage logic is covered by its tests.
    useForYouSyncStatusMessage: () => null,
    useForYouChunkStates: () => [],
    useForYouHydrationProgress: () => ({ hydrationCompleted: 0, hydrationTotal: 0 }),
    useForYouLastProcessingRunFinishedAt: () => null,
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

import FeedStatusPanel, { FeedStatusBody, STATUS_PANEL_AUTO_COLLAPSE_MS } from '../FeedStatusPanel';

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

    it('sits on the dark over-content base, passed as a style (GlassPanel ignores fallbackClassName)', () => {
        const { getByTestId } = render(<FeedStatusPanel expanded mode="processing" />);
        const { StyleSheet } = require('react-native');
        const style = StyleSheet.flatten(getByTestId('dashboard-status-details-panel').props.style);
        expect(style.backgroundColor).toBe('rgba(18,17,19,0.90)');
    });

    it('draws an OPAQUE base when floated over bare content (the Dashboard dropdown)', () => {
        const { getByTestId } = render(<FeedStatusPanel expanded mode="idle" opaque />);
        const { StyleSheet } = require('react-native');
        const { STATUS_PANEL_OPAQUE_BASE } = require('../status-ink');
        const style = StyleSheet.flatten(getByTestId('dashboard-status-details-panel').props.style);
        expect(style.backgroundColor).toBe(STATUS_PANEL_OPAQUE_BASE);
        // Opaque means alpha 1: section text showed through the 0.90 base.
        expect(STATUS_PANEL_OPAQUE_BASE).toMatch(/^rgb\(/);
    });

    it('closes itself after the one shared delay, the Feed\'s 3000ms', () => {
        expect(STATUS_PANEL_AUTO_COLLAPSE_MS).toBe(3000);
    });
});

describe('FeedStatusBody', () => {
    it('renders the same rows with no panel chrome, for hosts that bring their own', () => {
        mockBatchProgress = { done: 3, total: 10 };
        const { getByTestId, getByText, queryByTestId } = render(<FeedStatusBody mode="processing" />);
        expect(getByTestId('feed-status-details')).toBeTruthy();
        expect(getByText('feed.analysingProgress')).toBeTruthy();
        expect(queryByTestId('dashboard-status-details-panel')).toBeNull();
    });
});
