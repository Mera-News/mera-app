/* eslint-disable @typescript-eslint/no-require-imports */
// Nine routes that need a param. A malformed deep link reaches them with it
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
let mockParams: Record<string, string> = {};
let mockLastHref: unknown = null;
jest.mock('expo-router', () => {
    const ReactLib = require('react');
    return {
        router: { back: (...a: unknown[]) => mockBack(...a), canGoBack: () => false, replace: jest.fn() },
        useLocalSearchParams: () => mockParams,
        Redirect: ({ href }: { href: unknown }) => {
            mockLastHref = href;
            return ReactLib.createElement('View', {
                testID: 'redirect',
                accessibilityLabel: typeof href === 'string' ? href : JSON.stringify(href),
            });
        },
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
jest.mock('@/components/custom/config-panel/SourcesL2PublicationList', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/publication-page/PublicationPage', () => ({ __esModule: true, default: () => null }));
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
    ['publication', () => require('../logged-in/publication').default],
];

beforeEach(() => {
    mockBack.mockClear();
    mockParams = {};
    mockLastHref = null;
});

describe.each(ROUTES)('%s with its required param missing', (_name, load) => {
    it('redirects to the Feed and never navigates during render', () => {
        const Route = load();
        const screen = render(<Route />);
        const redirect = screen.getByTestId('redirect');
        expect(redirect.props.accessibilityLabel).toBe('/logged-in/app_container/feed');
        expect(mockBack).not.toHaveBeenCalled();
    });
});

// The two feed-era routes are redirect STUBS to the publication page now, so
// a restored navigation state or an old deep link still lands somewhere.
describe('feed-era route stubs', () => {
    it('publisher-articles opens the page on its Top headlines tab', () => {
        mockParams = { publisherId: 'pub-1', publisherName: 'Times of India' };
        const Route = require('../logged-in/publisher-articles').default;
        render(<Route />);
        expect(mockLastHref).toEqual({
            pathname: '/logged-in/publication',
            params: { publisherId: 'pub-1', name: 'Times of India', order: 'TOP_HEADLINES' },
        });
    });

    it('sources-articles opens the page by publisher name and country, ignoring the feed id', () => {
        mockParams = { publisherName: 'The Hindu', countryCode: 'IND', publicationSourceId: 'feed-9' };
        const Route = require('../logged-in/sources-articles').default;
        render(<Route />);
        expect(mockLastHref).toEqual({
            pathname: '/logged-in/publication',
            params: { name: 'The Hindu', country: 'IND' },
        });
    });
});
