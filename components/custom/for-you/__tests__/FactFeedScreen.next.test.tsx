/* eslint-disable @typescript-eslint/no-require-imports */
// Owner (reversing D4): "let's get rid of empty sections". The fact feed's
// "Next" footer skips sections with no stories and lands on the next one that
// has some; with none left it offers the way back. A fact opened directly
// (Profile, a deep link) still shows its own "looking for stories" state.
let mockRows: any[] = [];
const mockBuildFactRows = jest.fn((..._a: any[]) => ({ rows: mockRows }));
jest.mock('@/lib/stores/fact-rows-selector', () => ({
    ...jest.requireActual('@/lib/stores/fact-rows-selector'),
    buildFactRows: (...a: any[]) => mockBuildFactRows(...a),
    isHeadlineSectionId: () => false,
    isSuggestionOpened: () => false,
}));
let mockLiveCtx: any = null;
jest.mock('@/lib/user-context/user-geo-language-context', () => ({
    useUserGeoLanguageContext: () => mockLiveCtx,
}));
jest.mock('@/components/custom/for-you/use-section-snapshots', () => ({ useSectionSnapshots: () => ({}) }));
jest.mock('@/lib/stores/selectors', () => ({ useForYouSuggestions: () => [] }));
jest.mock('@/lib/stores/opened-stories-store', () => {
    const state = { articleIds: new Set(), ids: new Set(), hydrate: async () => {} };
    const hook: any = (sel: any) => sel(state);
    hook.getState = () => state;
    return { useOpenedStoriesStore: hook };
});
jest.mock('@/lib/stores/section-visits-store', () => ({
    useSectionVisitsStore: { getState: () => ({ hydrate: async () => {}, visits: {}, markVisited: jest.fn() }) },
}));
jest.mock('@/lib/hooks/use-open-suggestion', () => ({ useOpenSuggestion: () => jest.fn() }));
jest.mock('@/components/custom/feed/use-feedback-sheet', () => ({
    useFeedbackSheet: () => ({ onVerdict: jest.fn(), onAskMera: jest.fn(), feedbackHandlers: {} }),
}));
jest.mock('@/components/custom/cards/ArticleSuggestionCard', () => ({ ArticleSuggestionCard: () => null }));
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/AllCaughtUpCard', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID={p.testID ?? 'empty-state'} /> };
});
jest.mock('@/components/custom/for-you/NextSectionFooter', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID={`footer-${p.kind}`} accessibilityLabel={p.factId ?? ''} /> };
});
jest.mock('@/components/custom/ScrollToTopFab', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({
    GLASS_HEADER_SCRIM: '#000',
    GLASS_HEADER_TINT: '#000',
    GlassHeaderAndroidBackdrop: () => null,
    GlassPlate: ({ children }: any) => children ?? null,
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
// The list itself is irrelevant here (the rows are built in a memo above it).
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const R = require('react');
    // Draws what the screen hands it: the empty state when there are no rows,
    // then the footer.
    const FlatList = (p: any) =>
        R.createElement(actual.View, null, (p.data ?? []).length === 0 ? p.ListEmptyComponent : null, p.ListFooterComponent);
    return new Proxy(actual, { get: (t, k) => (k === 'FlatList' ? FlatList : (t as any)[k]) });
});
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const chain: any = new Proxy(() => chain, { get: () => chain });
    return { __esModule: true, default: { View }, FadeIn: chain, useReducedMotion: () => false };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { render } from '@testing-library/react-native';
import React from 'react';

const group = (id: string) => ({ data: { _id: id, articleId: id }, pubDateMs: 1, addedMs: 1, bucket: 'MEDIUM' });
const populated = (factId: string) => ({ factId, kind: 'fact', statement: factId, groups: [group(`${factId}-g`)] });
const empty = (factId: string) => ({ factId, kind: 'fact', statement: factId, groups: [], emptyReason: 'no-match-yet' });

beforeEach(() => {
    mockLiveCtx = { homeCountryAlpha3: 'NLD', otherCountriesAlpha3: [], appLanguageBase: 'en', preferredPublications: new Set() };
});

describe('FactFeedScreen: Next skips empty sections', () => {
    const FactFeedScreen = () => require('../FactFeedScreen').default;

    it('jumps over an empty section to the next one with stories', () => {
        mockRows = [populated('f1'), empty('f2'), populated('f3'), empty('f4')];
        const Screen = FactFeedScreen();
        const r = render(<Screen factId="f1" title="f1" />);
        expect(r.getByTestId('footer-next').props.accessibilityLabel).toBe('f3');
    });

    it('offers the way back when only empty sections remain', () => {
        mockRows = [populated('f1'), empty('f2'), populated('f3'), empty('f4')];
        const Screen = FactFeedScreen();
        const r = render(<Screen factId="f3" title="f3" />);
        expect(r.queryByTestId('footer-next')).toBeNull();
        expect(r.getByTestId('footer-back')).toBeTruthy();
    });

    it('a directly opened empty fact still shows its own empty state, and Next goes on to stories', () => {
        mockRows = [populated('f1'), empty('f2'), populated('f3')];
        const Screen = FactFeedScreen();
        const r = render(<Screen factId="f2" title="f2" />);
        expect(r.getByTestId('fact-feed-empty-section')).toBeTruthy();
        expect(r.getByTestId('footer-next').props.accessibilityLabel).toBe('f3');
    });
});
