/* eslint-disable @typescript-eslint/no-require-imports */
// The status body's rows are the same wherever it opens. "Last processed" used
// to be a prop only the Dashboard passed, so the Feed's panel lacked the row;
// the body now reads it itself.

import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/lib/utils/time-ago', () => ({
    formatTimeAgo: () => '2 minutes ago',
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'en' }));
jest.mock('@/lib/services/scoring-error', () => ({ SCORING_ERROR_I18N_KEYS: {} }));
jest.mock('@/lib/utils/format-count', () => ({ formatCount: (n: number) => String(n) }));
jest.mock('@/lib/hooks/use-feed-counts', () => ({
    useFeedCounts: () => ({ articleCount: 12, analysedCount: 8, relevantCount: 3, readCount: 1 }),
}));
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
// Icons render their real private-use glyph, as they do on device.
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});

let mockFinishedAt: number | null = null;
let mockLimitResetAt: number | null = null;
jest.mock('@/lib/stores/selectors', () => ({
    useForYouAsyncJobPhase: () => 'idle',
    useForYouAsyncJobProcessedCount: () => 0,
    useForYouAsyncJobTotalCount: () => 0,
    useForYouBatchProgress: () => null,
    useForYouDailyLimitResetAt: () => mockLimitResetAt,
    useForYouDeviceProcessing: () => ({
        isDeviceProcessing: false,
        deviceProcessedCount: 0,
        deviceTotalCount: 0,
    }),
    useForYouScoringError: () => null,
    useForYouSyncStatusMessage: () => null,
    useForYouLastProcessingRunFinishedAt: () => mockFinishedAt,
}));

import FeedStatusDetails from '../FeedStatusDetails';

beforeEach(() => {
    mockFinishedAt = null;
    mockLimitResetAt = null;
});

describe('FeedStatusDetails', () => {
    it('shows "Last processed" from the store, with no prop from the screen', () => {
        mockFinishedAt = Date.now() - 120_000;
        const { getByText } = render(<FeedStatusDetails />);
        expect(getByText('feedStatus.lastProcessed')).toBeTruthy();
        expect(getByText('2 minutes ago')).toBeTruthy();
    });

    it('omits the row before any run has finished', () => {
        const { queryByText, getByText } = render(<FeedStatusDetails />);
        // Presence first, so the absence below is not a query that finds nothing.
        expect(getByText('feedStatus.published')).toBeTruthy();
        expect(queryByText('feedStatus.lastProcessed')).toBeNull();
    });
});

// Captured (sim R3, 2544): the open dropdown, its panel and a StaticText all
// read as the stage row's "sync" icon glyph, and later (2617) the icon was its
// own StaticText inside the labelled row. The words are the accessible element
// and every glyph sits outside any accessible element, hidden itself.
describe('FeedStatusDetails: the stage row never reads as its icon', () => {
    const PUA = /[\uE000-\uF8FF]/;
    it('labels the stage row with its words', () => {
        const { privateUseLabelLeaks } = require('@/lib/__test-helpers__/icon-glyph-a11y');
        const r = render(<FeedStatusDetails />);
        const row = r.getByTestId('feed-status-stage-row');
        expect(row.props.accessible).toBe(true);
        expect(row.props.accessibilityLabel).toBe('feedStatus.idle');
        expect(privateUseLabelLeaks(r.UNSAFE_root)).toEqual([]);
    });

    // Captured (batch 26): the row read right, but the icon inside it was
    // STILL its own StaticText. No private-use Text may be exposed anywhere:
    // each must be hidden itself and sit under no accessible element.
    it('exposes no private-use StaticText anywhere in the tree', () => {
        // Daily limit on, so the Manage plan pill and its card glyph render too.
        mockLimitResetAt = Date.now() + 3_600_000;
        const r = render(<FeedStatusDetails />);
        expect(r.getByTestId('feed-status-manage-subscription')).toBeTruthy();
        const glyphs = r.UNSAFE_root.findAll(
            (n: any) => typeof n.type === 'string' && PUA.test(String(n.props?.children ?? '')),
        );
        expect(glyphs.length).toBeGreaterThan(0);
        for (const g of glyphs) {
            expect(g.props.accessible).toBe(false);
            expect(g.props.accessibilityElementsHidden).toBe(true);
            expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
            for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
        }
    });
});
