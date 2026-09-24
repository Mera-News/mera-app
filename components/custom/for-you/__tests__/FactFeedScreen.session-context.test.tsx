/* eslint-disable @typescript-eslint/no-require-imports */
// FactFeedScreen holds its geo/language context for the visit (batch 17, same
// rule as the Feed): a publication-preference write from a card's ••• sheet
// re-loads the live context, and a live one regrouped and re-sorted the cards
// under the reader. The screen's rows must be built with the context the visit
// started with.
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
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
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

const ctx = (preferred: string[]) => ({
    homeCountryAlpha3: 'NLD',
    otherCountriesAlpha3: [],
    appLanguageBase: 'en',
    preferredPublications: new Set(preferred),
});

it('builds its rows with the context the visit started with, not one a preference write re-loaded', () => {
    const FactFeedScreen = require('../FactFeedScreen').default;
    const first = ctx([]);
    mockLiveCtx = first;
    const r = render(<FactFeedScreen factId="f1" title="Fact" />);
    const lastCtx = () => mockBuildFactRows.mock.calls[mockBuildFactRows.mock.calls.length - 1][5];
    expect(lastCtx()).toBe(first);
    // "More from this publication" → the live context re-loads with it preferred.
    mockLiveCtx = ctx(['it pro']);
    r.rerender(<FactFeedScreen factId="f1" title="Fact" />);
    expect(lastCtx()).toBe(first);
    // A new visit (another fact) takes the live context.
    r.rerender(<FactFeedScreen factId="f2" title="Other" />);
    expect(lastCtx()).toBe(mockLiveCtx);
});
