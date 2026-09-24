/* eslint-disable @typescript-eslint/no-require-imports */
// ArticleSuggestionScreen: the local load path, and WHEN it may delete a card.
//
// A read that THROWS proves nothing about the row, so it must never delete.
// Only a confirmed not-found (feed table AND saved table both empty) drops the
// stale card, and it does so once per load, never from render.

import { render, waitFor } from '@testing-library/react-native';
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
    useTranslation: () => ({ t: (k: string) => k }),
}));

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/news-detail/FactCheckPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/news-detail/ReadTranslateActions', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/news-detail/RelatedSortDropdown', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/PublicationVisitBadge', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ScrollToTopFab', () => ({ __esModule: true, default: () => null }));
// Records what the screen hands the status area, the back button and the
// scroll container, so the "no dark header" rule can be asserted here.
const mockHeaderProps: { scrim?: any; bar?: any; container?: any } = {};
jest.mock('@/components/custom/StatusBarScrim', () => ({
    __esModule: true,
    default: (p: any) => {
        mockHeaderProps.scrim = p;
        return null;
    },
}));
jest.mock('@/components/custom/news-detail/DetailTopBar', () => {
    const { Pressable } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => {
            mockHeaderProps.bar = p;
            return <Pressable testID="detail-back" onPress={p.onBack} />;
        },
    };
});
jest.mock('@/components/custom/ArticleFeedbackPrompt', () => ({ ArticleFeedbackPrompt: () => null }));
jest.mock('@/components/custom/ArticleSuggestionContainer', () => ({
    ArticleSuggestionContainer: (p: any) => {
        mockHeaderProps.container = p;
        return null;
    },
}));
jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => ({
    ArticleStandaloneCompactCard: () => null,
}));
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/toast', () => ({
    Toast: () => null,
    ToastTitle: () => null,
    ToastDescription: () => null,
    useToast: () => ({ show: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/lib/fact-check/request-article-fact-check', () => ({ requestArticleFactCheck: jest.fn() }));
jest.mock('@/lib/fact-check/use-fact-check', () => ({ useFactCheck: () => ({ phase: 'absent' }) }));
jest.mock('@/lib/fact-check/fact-check-graphql-client', () => ({ fetchCachedFactCheck: jest.fn() }));

const mockGetSuggestion = jest.fn();
const mockDeleteSuggestion = jest.fn();
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getSuggestionByServerId: (...a: unknown[]) => mockGetSuggestion(...a),
    deleteSuggestionByServerId: (...a: unknown[]) => mockDeleteSuggestion(...a),
}));
const mockGetSaved = jest.fn();
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
    getSavedSuggestionByServerId: (...a: unknown[]) => mockGetSaved(...a),
    isSuggestionSaved: () => Promise.resolve(false),
    saveSuggestion: jest.fn(),
    deleteSavedSuggestion: jest.fn(),
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({ recordPublicationVisit: jest.fn() }));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@/lib/saved-state', () => ({ useSavedOverride: () => null }));

const mockRemoveSuggestion = jest.fn();
jest.mock('@/lib/stores/for-you-store', () => {
    const state = { suggestions: [] as unknown[], removeSuggestion: (...a: unknown[]) => mockRemoveSuggestion(...a) };
    const useForYouStore = (sel: (s: typeof state) => unknown) => sel(state);
    useForYouStore.getState = () => state;
    return { useForYouStore };
});
jest.mock('@/lib/stores/fact-rows-selector', () => ({ isSuggestionOpened: () => false }));
jest.mock('@/lib/stores/opened-stories-store', () => ({
    useOpenedStoriesStore: (sel: (s: { ids: Set<string> }) => unknown) => sel({ ids: new Set() }),
}));
jest.mock('@/lib/feed-grouping/story-grouping', () => ({
    buildStoryGroups: () => [],
    CLUSTER_CORE_CONFIDENCE_THRESHOLD: 0,
    TITLE_JACCARD_DISPLAY_THRESHOLD: 0,
    WEIGHTED_JACCARD_DISPLAY_THRESHOLD: 0,
    ENTITY_JACCARD_DISPLAY_THRESHOLD: 0,
}));
jest.mock('@/lib/feed-grouping/related-articles-sort', () => ({ orderRelatedArticles: (e: unknown[]) => e }));
jest.mock('@/components/custom/news-detail/use-related-pagination', () => ({
    useRelatedPagination: () => ({
        entries: [],
        isLoadingInitial: false,
        isLoadingMore: false,
        hasNextPage: false,
        loadMore: jest.fn(),
    }),
}));
jest.mock('@/lib/stores/network-store', () => ({ useIsConnected: () => true }));
jest.mock('@/lib/stores/related-sort-store', () => ({
    useRelatedSortStore: (sel: (s: { mode: string; setMode: () => void }) => unknown) =>
        sel({ mode: 'default', setMode: () => {} }),
}));
jest.mock('@/lib/stores/subscription-store', () => ({ useAiAccess: () => 'entitled' }));
jest.mock('@/lib/user-context/user-geo-language-context', () => ({ useUserGeoLanguageContext: () => null }));
jest.mock('@/lib/web-browser-utils', () => ({ openArticleInAppBrowser: jest.fn() }));

import ArticleSuggestionScreen from '../ArticleSuggestionScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteSuggestion.mockResolvedValue(undefined);
});

describe('ArticleSuggestionScreen local load', () => {
    it('does not delete the card when the local read throws', async () => {
        mockGetSuggestion.mockRejectedValue(new Error('SQLITE_BUSY'));
        mockGetSaved.mockResolvedValue(null);

        const screen = render(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);

        await waitFor(() => expect(screen.getByText('articleDetail.failedToLoad')).toBeTruthy());
        expect(mockDeleteSuggestion).not.toHaveBeenCalled();
        expect(mockRemoveSuggestion).not.toHaveBeenCalled();
    });

    it('keeps a saved item that the feed table no longer holds', async () => {
        mockGetSuggestion.mockResolvedValue(null);
        mockGetSaved.mockRejectedValue(new Error('SQLITE_BUSY'));

        const screen = render(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);

        await waitFor(() => expect(screen.getByText('articleDetail.failedToLoad')).toBeTruthy());
        expect(mockDeleteSuggestion).not.toHaveBeenCalled();
    });

    it('deletes exactly once when both tables confirm the row is gone', async () => {
        mockGetSuggestion.mockResolvedValue(null);
        mockGetSaved.mockResolvedValue(null);

        const screen = render(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);

        await waitFor(() => expect(screen.getByText('articleDetail.storyUnavailable')).toBeTruthy());
        screen.rerender(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);
        screen.rerender(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);

        expect(mockDeleteSuggestion).toHaveBeenCalledTimes(1);
        expect(mockDeleteSuggestion).toHaveBeenCalledWith('s1');
        expect(mockRemoveSuggestion).toHaveBeenCalledTimes(1);
    });

    it('shows a way back while the local read is still loading (S8)', async () => {
        mockGetSuggestion.mockReturnValue(new Promise(() => {}));
        const screen = render(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);
        expect(screen.getByTestId('detail-back')).toBeTruthy();
    });

    // Owner: "earlier in detail page i never saw this dark header. even when
    // scrolled up." The loaded screen hands the status area only its top fade
    // (no scroll-driven cover), the back button no cover, and the scroll
    // container no top-bar callback: nothing can turn solid on scroll.
    it('has no dark header at any scroll position', async () => {
        mockGetSuggestion.mockResolvedValue({
            _id: 's1',
            articleId: 'a1',
            title_en: 'A story',
            publication_name: 'NOS',
            language_code: 'nl',
            clusters: [],
            matchedTopics: [],
            status: 'complete',
        });
        mockGetSaved.mockResolvedValue(null);
        render(<ArticleSuggestionScreen articleSuggestionId="s1" onBack={() => {}} />);
        await waitFor(() => expect(mockHeaderProps.container).toBeDefined());
        expect(mockHeaderProps.scrim).toEqual(expect.objectContaining({ overHero: true }));
        expect(mockHeaderProps.scrim.coverProgress).toBeUndefined();
        expect(mockHeaderProps.bar.cover).toBeUndefined();
        expect(mockHeaderProps.container.onTopBarSolidChange).toBeUndefined();
    });
});
