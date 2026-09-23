/* eslint-disable @typescript-eslint/no-require-imports */
// Eight routes that need a param. A malformed deep link reaches them with it
// missing, often with no history behind it. They used to call router.back()
// DURING RENDER (a side effect in render, and a no-op with no history, which
// left a blank screen). They now render a Redirect to the Dashboard.
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

const mockBack = jest.fn();
jest.mock('expo-router', () => {
    const ReactLib = require('react');
    return {
        router: { back: (...a: unknown[]) => mockBack(...a), canGoBack: () => false, replace: jest.fn() },
        useLocalSearchParams: () => ({}),
        Redirect: ({ href }: { href: string }) =>
            ReactLib.createElement('View', { testID: 'redirect', accessibilityLabel: href }),
    };
});

// Every screen the routes would render. A missing-param route must never get
// that far, so these are plain stubs.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));
jest.mock('react-native-safe-area-context', () => {
    const { View } = require('react-native');
    return { SafeAreaView: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/news-detail/ArticleDetailScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/news-detail/ArticleSuggestionScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/tracked-stories/StoryTimelineScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/SourcesArticleList', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/SourcesL2PublicationList', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/PublisherArticleList', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/PublicationArticleHistoryList', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/CountryArticleList', () => ({ __esModule: true, default: () => null }));

const ROUTES: [string, () => React.ComponentType][] = [
    ['article-detail', () => require('../logged-in/article-detail').default],
    ['suggestion-detail', () => require('../logged-in/suggestion-detail').default],
    ['story-timeline', () => require('../logged-in/story-timeline').default],
    ['sources-articles', () => require('../logged-in/sources-articles').default],
    ['sources-publishers', () => require('../logged-in/sources-publishers').default],
    ['publisher-articles', () => require('../logged-in/publisher-articles').default],
    ['publication-history', () => require('../logged-in/publication-history').default],
    ['country-articles', () => require('../logged-in/country-articles').default],
];

beforeEach(() => mockBack.mockClear());

describe.each(ROUTES)('%s with its required param missing', (_name, load) => {
    it('redirects to the Dashboard and never navigates during render', () => {
        const Route = load();
        const screen = render(<Route />);
        const redirect = screen.getByTestId('redirect');
        expect(redirect.props.accessibilityLabel).toBe('/logged-in/app_container/for_you');
        expect(mockBack).not.toHaveBeenCalled();
    });
});
