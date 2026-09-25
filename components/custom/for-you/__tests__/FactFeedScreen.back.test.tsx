/* eslint-disable @typescript-eslint/no-require-imports */
// The fact feed's Back button (captured, ux2 2712): a Button measured 24x24
// (hitSlop does not count on device) with its arrow glyph as a separate
// StaticText at the same spot. It is a 44pt numeric frame (NativeWind rem is
// 14, so w-11 is 38.5pt) holding the hidden glyph, with a childless labelled
// Pressable laid over it.
const mockBuildFactRows = jest.fn((..._a: any[]) => ({ rows: [] }));
jest.mock('@/lib/stores/fact-rows-selector', () => ({
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
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/for-you/NextSectionFooter', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ScrollToTopFab', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({
    GLASS_HEADER_SCRIM: '#000',
    GLASS_HEADER_TINT: '#000',
    GlassHeaderAndroidBackdrop: () => null,
    GlassPlate: ({ children }: any) => children ?? null,
}));
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
// The list itself is irrelevant here (the rows are built in a memo above it).
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    return new Proxy(actual, { get: (t, p) => (p === 'FlatList' ? () => null : (t as any)[p]) });
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
import { StyleSheet } from 'react-native';

const PUA = /[\uE000-\uF8FF]/;

beforeEach(() => {
    mockLiveCtx = {
        homeCountryAlpha3: 'NLD',
        otherCountriesAlpha3: [],
        appLanguageBase: 'en',
        preferredPublications: new Set(),
    };
});

describe('FactFeedScreen Back button', () => {
    it('is a 44x44 numeric frame', () => {
        const FactFeedScreen = require('../FactFeedScreen').default;
        const r = render(<FactFeedScreen factId="f1" title="Fact" />);
        const flat = StyleSheet.flatten(r.getByTestId('fact-feed-back-frame').props.style) ?? {};
        expect(flat.width).toBe(44);
        expect(flat.height).toBe(44);
        // Pulled back to the 24pt glyph footprint so the header does not reflow.
        expect(flat.margin).toBe(-10);
    });

    it('is a childless labelled button, and the arrow glyph is no StaticText', () => {
        const FactFeedScreen = require('../FactFeedScreen').default;
        const r = render(<FactFeedScreen factId="f1" title="Fact" />);
        const back = r.getByTestId('fact-feed-back');
        expect(back.props.accessibilityLabel).toBe('common.back');
        expect(back.props.accessibilityRole).toBe('button');
        const glyphs = r.UNSAFE_root.findAll(
            (n: any) => typeof n.type === 'string' && PUA.test(String(n.props?.children ?? '')),
        );
        // Presence first: the arrow is drawn, so the checks below are not vacuous.
        expect(glyphs.length).toBeGreaterThan(0);
        for (const g of glyphs) {
            expect(g.props.accessible).toBe(false);
            expect(g.props.accessibilityElementsHidden).toBe(true);
            expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
            for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
        }
    });

    it('goes back on tap', () => {
        const { router } = require('expo-router');
        const spy = jest.spyOn(router, 'back').mockImplementation(() => {});
        const { fireEvent } = require('@testing-library/react-native');
        const FactFeedScreen = require('../FactFeedScreen').default;
        const r = render(<FactFeedScreen factId="f1" title="Fact" />);
        fireEvent.press(r.getByTestId('fact-feed-back'));
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
