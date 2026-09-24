/* eslint-disable @typescript-eslint/no-require-imports */
// The Dashboard's Overview stats card. It carries the article-count sentence
// that left the header, and opens the same status body the Feed's mark opens,
// closing it after the same delay (owner: "make them similar"). The disclosure
// hook is REAL here: the auto-hide is the behaviour under test.

import { act, fireEvent, render } from '@testing-library/react-native';
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
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID={`icon-${p.name}`} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { GlassPanel: (p: any) => <View testID={p.testID}>{p.children}</View> };
});
let mockArticleCount = 12;
jest.mock('@/lib/hooks/use-feed-counts', () => ({
    useFeedCounts: () => ({ articleCount: mockArticleCount }),
}));
let mockMode = 'idle';
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => mockMode }));
jest.mock('../FeedStatsSentence', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stats-sentence" /> };
});
// The body has its own suite; here it only has to be identifiable. The delay
// constant is the REAL one, so this suite fails if the two tabs drift apart.
jest.mock('../FeedStatusPanel', () => {
    const { View } = require('react-native');
    const actual = jest.requireActual('../FeedStatusPanel');
    return {
        STATUS_PANEL_AUTO_COLLAPSE_MS: actual.STATUS_PANEL_AUTO_COLLAPSE_MS,
        FeedStatusBody: (p: any) => <View testID={`status-body-${p.mode}`} />,
    };
});
// FeedStatusPanel's real module pulls reanimated and the processing snapshot;
// requireActual above only needs the constant, so stub what it imports.
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const anim = { duration: () => anim };
    return { __esModule: true, default: { View }, FadeIn: anim, FadeOut: anim, LinearTransition: {} };
});
jest.mock('@/components/custom/processing/use-processing-snapshot', () => ({ useProcessingSnapshot: () => ({}) }));
jest.mock('@/components/custom/processing/ChunkStrip', () => () => null);
jest.mock('@/lib/stores/selectors', () => ({}));
jest.mock('../FeedStatusDetails', () => () => null);

import DashboardStatsCard from '../DashboardStatsCard';

beforeEach(() => {
    mockArticleCount = 12;
    mockMode = 'idle';
    jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('DashboardStatsCard', () => {
    it('shows the article-count sentence, collapsed', () => {
        const r = render(<DashboardStatsCard />);
        expect(r.getByTestId('stats-sentence')).toBeTruthy();
        expect(r.queryByTestId('status-body-idle')).toBeNull();
    });

    it('opens the shared status body on tap', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        expect(r.getByTestId('status-body-idle')).toBeTruthy();
    });

    it('auto-hides after the same delay as the Feed\'s panel (3000ms)', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        act(() => {
            jest.advanceTimersByTime(2999);
        });
        expect(r.getByTestId('status-body-idle')).toBeTruthy();
        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(r.queryByTestId('status-body-idle')).toBeNull();
    });

    it('closes early on a second tap', () => {
        const r = render(<DashboardStatsCard />);
        const toggle = r.getByTestId('dashboard-stats-card-toggle');
        fireEvent.press(toggle);
        fireEvent.press(toggle);
        expect(r.queryByTestId('status-body-idle')).toBeNull();
    });

    it('is still rendered at zero articles, showing the status line instead', () => {
        mockArticleCount = 0;
        mockMode = 'limited';
        const r = render(<DashboardStatsCard />);
        expect(r.queryByTestId('stats-sentence')).toBeNull();
        expect(r.getByTestId('dashboard-stats-card-state').props.children).toBe('feedStatus.modeLimited');
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        expect(r.getByTestId('status-body-limited')).toBeTruthy();
    });

    it('labels the toggle with the state first, then the action', () => {
        const r = render(<DashboardStatsCard />);
        const toggle = r.getByTestId('dashboard-stats-card-toggle');
        expect(toggle.props.accessibilityLabel).toBe('feedStatus.idle. feedStatus.openA11y');
    });
});
