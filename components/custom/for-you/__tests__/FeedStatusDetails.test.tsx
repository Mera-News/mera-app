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
jest.mock('@/lib/stores/selectors', () => ({
    useForYouAsyncJobPhase: () => 'idle',
    useForYouAsyncJobProcessedCount: () => 0,
    useForYouAsyncJobTotalCount: () => 0,
    useForYouBatchProgress: () => null,
    useForYouDailyLimitResetAt: () => null,
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
