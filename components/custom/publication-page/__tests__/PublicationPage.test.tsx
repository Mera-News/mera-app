/* eslint-disable @typescript-eslint/no-require-imports */
// The publication page: one test per profile state and per news-list state,
// the Latest | Top headlines switch, more/fewer and Subscribe. Every absence
// assertion sits beside the presence assertion that proves the query can see
// the thing at all.
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
    useTranslation: () => ({
        t: (key: string, o?: Record<string, unknown>) => (o && Object.keys(o).length ? `${key}:${JSON.stringify(o)}` : key),
        i18n: { language: 'en' },
    }),
}));

// FlatList renders its header, rows, empty and footer slots, and exposes the
// refresh control and scroll handlers, so no slot assertion is vacuous.
let mockLastList: any = null;
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'FlatList') {
                return ReactLib.forwardRef((props: any, ref: any) => {
                    mockLastList = props;
                    ReactLib.useImperativeHandle(ref, () => ({ scrollToOffset: jest.fn() }));
                    const slot = (c: any) =>
                        ReactLib.isValidElement(c) ? c : typeof c === 'function' ? ReactLib.createElement(c) : null;
                    const rows = props.data ?? [];
                    return ReactLib.createElement(
                        actual.View,
                        { testID: 'publication-list' },
                        slot(props.ListHeaderComponent),
                        rows.length === 0
                            ? slot(props.ListEmptyComponent)
                            : rows.map((item: any, index: number) =>
                                  ReactLib.createElement(
                                      ReactLib.Fragment,
                                      { key: props.keyExtractor(item, index) },
                                      props.renderItem({ item, index }),
                                  ),
                              ),
                        slot(props.ListFooterComponent),
                    );
                });
            }
            if (prop === 'RefreshControl') return (p: any) => ReactLib.createElement(actual.View, p);
            return (target as any)[prop];
        },
    });
});

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => { const { View, Text } = require('react-native'); return { Button: (p: any) => <View {...p} />, ButtonText: (p: any) => <Text {...p} /> }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

jest.mock('@/components/custom/config-panel/DrillDownHeader', () => {
    const { View, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ titleContent, onBack, backTestID }: any) => (
            <View>
                <Pressable testID={backTestID} onPress={onBack} />
                {titleContent}
            </View>
        ),
    };
});
jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => {
    const { Pressable, Text } = require('react-native');
    return {
        ArticleStandaloneCompactCard: ({ article, onPress }: any) => (
            <Pressable testID={`row-${article._id}`} onPress={onPress}>
                <Text>{article.title}</Text>
            </Pressable>
        ),
    };
});

const mockBegin = jest.fn();
let mockSubscribed = false;
jest.mock('@/components/custom/publication-preferences/use-subscribe-flow', () => ({
    useSubscribeFlow: () => ({
        begin: (...a: unknown[]) => mockBegin(...a),
        confirming: null,
        onYes: jest.fn(),
        onNo: jest.fn(),
        onDismiss: jest.fn(),
        isSubscribed: () => mockSubscribed,
    }),
}));
jest.mock('@/components/custom/publication-preferences/SubscribeConfirmDialog', () => ({ __esModule: true, default: () => null }));

const mockSetParams = jest.fn();
const mockFocusCallbacks: (() => void | (() => void))[] = [];
jest.mock('expo-router', () => {
    const ReactLib = require('react');
    return {
        router: { setParams: (...a: unknown[]) => mockSetParams(...a), push: jest.fn() },
        useFocusEffect: (cb: () => void | (() => void)) => {
            mockFocusCallbacks.push(cb);
            ReactLib.useEffect(cb, [cb]);
        },
    };
});
jest.mock('@/lib/nav-state', () => ({ getCurrentPathname: () => '/logged-in/publication' }));
jest.mock('@/lib/stores/publication-display-store', () => ({ useDisplayPublication: (n: string) => n }));
const mockOpenArticle = jest.fn();
jest.mock('@/lib/hooks/use-open-article', () => ({ useOpenArticle: () => mockOpenArticle }));
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));
const mockOpenInAppBrowser = jest.fn(async () => ({ type: 'opened' }));
jest.mock('@/lib/web-browser-utils', () => ({ openInAppBrowser: (...a: unknown[]) => (mockOpenInAppBrowser as any)(...a) }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/country-utils', () => ({ getCountryName: (c: string) => `Country(${c})` }));
jest.mock('@/lib/language-names', () => ({ getLocalizedLanguageName: (c: string) => `Lang(${c})` }));
const mockRecordVisit = jest.fn();
jest.mock('@/lib/database/services/publication-visit-service', () => ({ recordPublicationVisit: (...a: unknown[]) => mockRecordVisit(...a) }));

// The one seam to the data layer.
let mockProfile: any = { state: 'loading', profile: null, retry: jest.fn() };
const NEWS_BASE = { articles: [], state: 'idle', loadMoreState: 'idle', hasMore: false, orderApplied: true, isLocal: false, refreshing: false };
let mockNews: any = { ...NEWS_BASE, loadMore: jest.fn(), refresh: jest.fn() };
let mockPref: any = { level: 'none', busy: false, names: ['The Hindu'], change: jest.fn() };
const mockReloadHistory = jest.fn();
let mockHistory: any = { state: 'ready', visits: [], reload: mockReloadHistory };
const mockHistoryArgs: unknown[][] = [];
const mockProfileKeys: unknown[] = [];
const mockNewsArgs: unknown[][] = [];
const mockPrefNames: unknown[] = [];
jest.mock('../publication-data', () => ({
    usePublicationProfile: (key: unknown) => {
        mockProfileKeys.push(key);
        return mockProfile;
    },
    usePublicationArticles: (...a: unknown[]) => {
        mockNewsArgs.push(a);
        return mockNews;
    },
    usePublicationPref: (hints: unknown) => {
        mockPrefNames.push(hints);
        return mockPref;
    },
    usePublicationHistory: (...a: unknown[]) => {
        mockHistoryArgs.push(a);
        return mockHistory;
    },
}));
let mockFocused = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));

import PublicationPage from '../PublicationPage';
import { isPublicationOnTop } from '../open-publication-page';

const HIDDEN = { includeHiddenElements: true } as const;

const PROFILE = {
    newsPublisherId: 'pub-1',
    name: 'The Hindu',
    displayName: 'The Hindu',
    homepageUrl: 'https://www.thehindu.com/',
    publicationType: 'regulator',
    categories: ['general_news'],
    languages: ['en'],
    isOfficial: true,
    countryCode: 'IND',
    countryName: 'India',
    sourceNames: ['The Hindu', 'The Hindu Business Line'],
    subscriptionUri: 'https://www.thehindu.com/subscribe',
};

function article(id: string) {
    return { _id: id, title: `Story ${id}` };
}

function renderPage(props: Partial<React.ComponentProps<typeof PublicationPage>> = {}) {
    return render(
        <PublicationPage
            publisherId={'publisherId' in props ? props.publisherId : 'pub-1'}
            rawName={'rawName' in props ? props.rawName : 'The Hindu'}
            countryCode={'countryCode' in props ? props.countryCode : 'IND'}
            order={props.order ?? 'NEWEST'}
            onBack={props.onBack ?? jest.fn()}
        />,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribed = false;
    mockProfile = { state: 'loading', profile: null, retry: jest.fn() };
    mockNews = { ...NEWS_BASE, loadMore: jest.fn(), refresh: jest.fn() };
    mockPref = { level: 'none', busy: false, names: ['The Hindu'], change: jest.fn() };
    mockProfileKeys.length = 0;
    mockHistoryArgs.length = 0;
    mockHistory = { state: 'ready', visits: [], reload: mockReloadHistory };
    mockFocused = true;
    mockNewsArgs.length = 0;
    mockPrefNames.length = 0;
    mockFocusCallbacks.length = 0;
});

describe('keying', () => {
    it('looks the profile up by publisher id when it has one', () => {
        renderPage();
        expect(mockProfileKeys[0]).toEqual({ publisherId: 'pub-1' });
    });

    it('looks it up by raw name plus country otherwise', () => {
        renderPage({ publisherId: null, rawName: 'De Telegraaf', countryCode: 'NLD' });
        expect(mockProfileKeys[0]).toEqual({ rawName: 'De Telegraaf', countryCode: 'NLD' });
    });

    it('starts the news request as soon as the id is known, before the profile lands', () => {
        renderPage();
        expect(mockNewsArgs[0].slice(0, 2)).toEqual(['pub-1', 'NEWEST']);
    });

    it('uses the profile id for the news when the page was opened by name', () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        renderPage({ publisherId: null });
        expect(mockNewsArgs[0].slice(0, 2)).toEqual(['pub-1', 'NEWEST']);
    });
});

describe('profile states', () => {
    it('loading: the entry point name and a fixed-height skeleton', () => {
        const { getByTestId, getByText } = renderPage();
        expect(getByText('The Hindu', HIDDEN)).toBeTruthy();
        const skeleton = getByTestId('publication-profile-skeleton', HIDDEN);
        expect(skeleton.props.style.minHeight).toBeGreaterThan(0);
    });

    it('ready: monogram, website host, data line and official badge', () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByText, getByTestId, queryByTestId } = renderPage();
        expect(getByText('T', HIDDEN)).toBeTruthy();
        expect(getByText('thehindu.com', HIDDEN)).toBeTruthy();
        expect(getByText('India · Lang(en) · General news')).toBeTruthy();
        expect(getByText('sources.badgeRegulator')).toBeTruthy();
        expect(getByTestId('publication-order-switch')).toBeTruthy();
        expect(queryByTestId('publication-profile-skeleton', HIDDEN)).toBeNull();
    });

    it('the website opens the in-app browser and records NO publication visit', async () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId } = renderPage();
        const link = getByTestId('publication-website');
        expect(link.props.accessibilityLabel).toBe('publicationPage.websiteA11y:{"host":"thehindu.com"}');
        await act(async () => {
            fireEvent.press(link);
        });
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://www.thehindu.com/');
        expect(mockRecordVisit).not.toHaveBeenCalled();
    });

    it('an http homepage still gets its link, shown without a scheme and opened over https', async () => {
        mockProfile = { state: 'ready', profile: { ...PROFILE, homepageUrl: 'http://x.cz/' }, retry: jest.fn() };
        const { getByText, getByTestId } = renderPage();
        expect(getByText('x.cz', HIDDEN)).toBeTruthy();
        await act(async () => {
            fireEvent.press(getByTestId('publication-website'));
        });
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://x.cz/');
    });

    it('a javascript: or garbage homepage shows no link', () => {
        for (const homepageUrl of ['javascript:alert(1)', 'not a url']) {
            mockProfile = { state: 'ready', profile: { ...PROFILE, homepageUrl }, retry: jest.fn() };
            const { queryByTestId, getByTestId, unmount } = renderPage();
            expect(getByTestId('publication-header')).toBeTruthy();
            expect(queryByTestId('publication-website')).toBeNull();
            unmount();
        }
    });

    it('offline: the entry point data plus the connect hint, and the news still shows', () => {
        mockProfile = { state: 'offline', profile: null, retry: jest.fn() };
        mockNews = { ...mockNews, state: 'offline', articles: [article('a1')] };
        const { getByText, getByTestId } = renderPage();
        expect(getByText('publicationPage.offlineHint')).toBeTruthy();
        expect(getByText('Country(IND)')).toBeTruthy();
        expect(getByTestId('row-a1')).toBeTruthy();
    });

    it('error: "Couldn\'t load details" with a working Try again, and the news still loads by id', () => {
        const retry = jest.fn();
        mockProfile = { state: 'error', profile: null, retry };
        const { getByText, getByTestId } = renderPage();
        expect(getByText('publicationPage.loadError')).toBeTruthy();
        fireEvent.press(getByTestId('publication-error-retry'));
        expect(retry).toHaveBeenCalled();
        expect(mockNewsArgs[0].slice(0, 2)).toEqual(['pub-1', 'NEWEST']);
    });

    it('unsupported server opened by id: name, country, and the news by id (Top headlines on an old server)', () => {
        mockProfile = { state: 'unsupported', profile: null, retry: jest.fn() };
        mockNews = { ...mockNews, state: 'ready', orderApplied: false, articles: [article('a1')] };
        const { getByText, getByTestId, queryByTestId } = renderPage();
        expect(getByText('Country(IND)')).toBeTruthy();
        expect(mockNewsArgs[0].slice(0, 2)).toEqual(['pub-1', 'NEWEST']);
        expect(getByTestId('row-a1')).toBeTruthy();
        expect(getByTestId('publication-order-top').props.accessibilityState).toEqual({ selected: true });
        expect(queryByTestId('publication-order-latest')).toBeNull();
    });

    it('unsupported server opened by name: the entry point name and country only, no news', () => {
        mockProfile = { state: 'unsupported', profile: null, retry: jest.fn() };
        const { getByText, queryByTestId } = renderPage({ publisherId: null });
        expect(getByText('The Hindu', HIDDEN)).toBeTruthy();
        expect(getByText('Country(IND)')).toBeTruthy();
        // No news pills; History alone stays (the reader's own visits need no server).
        expect(queryByTestId('publication-order-top')).toBeNull();
        expect(queryByTestId('publication-order-latest')).toBeNull();
        expect(queryByTestId('publication-order-history')).toBeTruthy();
        expect(queryByTestId('publication-news-empty')).toBeNull();
        expect(mockNewsArgs[0].slice(0, 2)).toEqual([null, 'NEWEST']);
    });

    it('not found: the not-found line, and more/fewer still works by name', () => {
        mockProfile = { state: 'notFound', profile: null, retry: jest.fn() };
        const { getByText, getByTestId, queryByTestId } = renderPage({ publisherId: null });
        expect(getByText('publicationPage.notFound')).toBeTruthy();
        expect(getByTestId('publication-pref-up')).toBeTruthy();
        expect(mockPrefNames[0]).toEqual({ publisherId: null, rawName: 'The Hindu', publisherName: undefined, sourceNames: undefined });
        expect(queryByTestId('publication-order-top')).toBeNull();
        expect(queryByTestId('publication-order-history')).toBeTruthy();
    });
});

describe('more/fewer', () => {
    it('is the first thing under the name, and keys on every name the publication is known by', () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId } = renderPage();
        const header = getByTestId('publication-page-header');
        // Identity first, then the reader's control: the first thing under the name.
        expect(header.props.children[0].type).toBe(require('../PublicationHeader').default);
        expect(header.props.children[1].props.testID).toBe('publication-pref-row');
        expect(mockPrefNames[0]).toEqual({
            publisherId: 'pub-1',
            rawName: 'The Hindu',
            publisherName: 'The Hindu',
            sourceNames: ['The Hindu', 'The Hindu Business Line'],
        });
        expect(mockNewsArgs[0][2]).toEqual({ sourceNames: ['The Hindu', 'The Hindu Business Line'] });
    });

    it('names itself in words: "In your feed", Boost and Downrank, with spoken labels', () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByText, getByTestId } = renderPage();
        expect(getByText('freeTier.factsInFeedHeader')).toBeTruthy();
        expect(getByText('publicationPrefs.kindBoost', HIDDEN)).toBeTruthy();
        expect(getByText('publicationPrefs.kindDeprioritize', HIDDEN)).toBeTruthy();
        expect(getByTestId('publication-pref-up').props.accessibilityLabel).toBe('publicationPage.prefMoreA11y');
        expect(getByTestId('publication-pref-down').props.accessibilityLabel).toBe('publicationPage.prefFewerA11y');
    });

    it('marks the active choice selected, and a second tap on it clears it', () => {
        const change = jest.fn();
        mockPref = { level: 'prioritised', busy: false, names: ['The Hindu'], change };
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId } = renderPage();
        expect(getByTestId('publication-pref-up').props.accessibilityState).toEqual({ selected: true, disabled: false });
        expect(getByTestId('publication-pref-down').props.accessibilityState).toEqual({ selected: false, disabled: false });
        fireEvent.press(getByTestId('publication-pref-up'));
        expect(change).toHaveBeenCalledWith('none');
    });

    it('holds still while there is no name to write under', () => {
        mockPref = { level: 'none', busy: false, names: [], change: jest.fn() };
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId } = renderPage();
        expect(getByTestId('publication-pref-up').props.accessibilityState).toEqual({ selected: false, disabled: true });
    });

    it('a tap asks for the next level', () => {
        const change = jest.fn();
        mockPref = { level: 'none', busy: false, names: ['The Hindu'], change };
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId } = renderPage();
        fireEvent.press(getByTestId('publication-pref-down'));
        expect(change).toHaveBeenCalledWith('deprioritised');
    });
});

describe('subscribe', () => {
    it('offers the publisher subscribe page when there is one', () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId, queryByTestId } = renderPage();
        fireEvent.press(getByTestId('publication-subscribe'));
        expect(mockBegin).toHaveBeenCalledWith({
            publisherId: 'pub-1',
            publisherName: 'The Hindu',
            countryCode: 'IND',
            subscriptionUri: 'https://www.thehindu.com/subscribe',
        });
        expect(queryByTestId('publication-subscribed')).toBeNull();
    });

    it('shows a Subscribed state instead of disappearing when the reader subscribes', () => {
        mockSubscribed = true;
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { getByTestId, queryByTestId } = renderPage();
        expect(getByTestId('publication-subscribed')).toBeTruthy();
        expect(queryByTestId('publication-subscribe')).toBeNull();
    });

    it('is hidden with no subscribe page', () => {
        mockProfile = { state: 'ready', profile: { ...PROFILE, subscriptionUri: null }, retry: jest.fn() };
        const { queryByTestId, getByTestId } = renderPage();
        expect(getByTestId('publication-order-switch')).toBeTruthy();
        expect(queryByTestId('publication-subscribe')).toBeNull();
        expect(queryByTestId('publication-subscribed')).toBeNull();
    });
});

describe('the Latest | Top headlines switch', () => {
    beforeEach(() => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
    });

    it('marks Latest selected by default and switches with setParams, never a push', () => {
        const { getByTestId } = renderPage();
        expect(getByTestId('publication-order-latest').props.accessibilityState).toEqual({ selected: true });
        fireEvent.press(getByTestId('publication-order-top'));
        expect(mockSetParams).toHaveBeenCalledWith({ order: 'TOP_HEADLINES' });
    });

    it('switching back to Latest sets it explicitly', () => {
        const { getByTestId } = renderPage({ order: 'TOP_HEADLINES' });
        expect(mockNewsArgs[0].slice(0, 2)).toEqual(['pub-1', 'TOP_HEADLINES']);
        fireEvent.press(getByTestId('publication-order-latest'));
        expect(mockSetParams).toHaveBeenCalledWith({ order: 'NEWEST' });
    });

    it('never claims Latest when an older server answered with Top headlines', () => {
        mockNews = { ...mockNews, state: 'ready', orderApplied: false };
        const { getByTestId, queryByTestId, getByText } = renderPage();
        expect(getByTestId('publication-order-top').props.accessibilityState).toEqual({ selected: true });
        expect(queryByTestId('publication-order-latest')).toBeNull();
        expect(getByText('publicationPage.noTopHeadlines')).toBeTruthy();
    });

    it('a tap on the selected tab does nothing', () => {
        const { getByTestId } = renderPage();
        fireEvent.press(getByTestId('publication-order-latest'));
        expect(mockSetParams).not.toHaveBeenCalled();
    });
});

describe('the news list', () => {
    beforeEach(() => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
    });

    it('loading: a spinner', () => {
        mockNews = { ...mockNews, state: 'loading' };
        expect(renderPage().getByTestId('publication-news-loading')).toBeTruthy();
    });

    it('rows open the article', () => {
        mockNews = { ...mockNews, state: 'ready', articles: [article('a1'), article('a2')] };
        const { getByTestId, queryByTestId } = renderPage();
        fireEvent.press(getByTestId('row-a2'));
        expect(mockOpenArticle).toHaveBeenCalledWith({ articleId: 'a2' });
        expect(queryByTestId('publication-news-empty')).toBeNull();
    });

    it('error on the first load: text plus a Try again that refreshes', () => {
        const refresh = jest.fn(async () => {});
        mockNews = { ...mockNews, state: 'error', refresh };
        const { getByText, getByTestId } = renderPage();
        expect(getByText('publicationPage.newsLoadError')).toBeTruthy();
        fireEvent.press(getByTestId('publication-news-retry'));
        expect(refresh).toHaveBeenCalled();
    });

    it('each tab has its own empty text', () => {
        mockNews = { ...mockNews, state: 'ready' };
        expect(renderPage().getByText('publicationPage.noLatest')).toBeTruthy();
        expect(renderPage({ order: 'TOP_HEADLINES' }).getByText('publicationPage.noTopHeadlines')).toBeTruthy();
    });

    it('a failed load-more gets a Try again footer', () => {
        const loadMore = jest.fn();
        mockNews = { ...mockNews, state: 'ready', loadMoreState: 'error', articles: [article('a1')], loadMore };
        const { getByTestId } = renderPage();
        fireEvent.press(getByTestId('publication-news-more-retry'));
        expect(loadMore).toHaveBeenCalled();
    });

    it('loads more at the end only when there is more and nothing in flight', () => {
        const loadMore = jest.fn();
        mockNews = { ...mockNews, state: 'ready', articles: [article('a1')], hasMore: true, loadMore };
        renderPage();
        mockLastList.onEndReached();
        expect(loadMore).toHaveBeenCalledTimes(1);

        loadMore.mockClear();
        mockNews = { ...mockNews, loadMoreState: 'loading' };
        renderPage();
        mockLastList.onEndReached();
        expect(loadMore).not.toHaveBeenCalled();
    });

    it('pull to refresh refreshes the news', () => {
        const refresh = jest.fn(async () => {});
        mockNews = { ...mockNews, state: 'ready', articles: [article('a1')], refresh };
        renderPage();
        mockLastList.refreshControl.props.onRefresh();
        expect(refresh).toHaveBeenCalled();
    });

    it('ticks translation visibility on scroll and on content size change', () => {
        const { notifyScrollTick } = require('@/lib/visibility-tick');
        renderPage();
        expect(mockLastList.onScroll).toBe(notifyScrollTick);
        expect(mockLastList.onContentSizeChange).toBe(notifyScrollTick);
    });
});

describe('already on top', () => {
    it('registers itself while focused, so its own rows cannot push a second copy', () => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
        const { unmount } = renderPage({ publisherId: null });
        expect(isPublicationOnTop({ publisherId: 'pub-1' })).toBe(true);
        expect(isPublicationOnTop({ rawName: 'the hindu', countryCode: 'ind' })).toBe(true);
        expect(isPublicationOnTop({ publisherId: 'pub-2' })).toBe(false);
        unmount();
        expect(isPublicationOnTop({ publisherId: 'pub-1' })).toBe(false);
    });
});

describe('the History sub-tab', () => {
    const visit = (articleId: string | null, title: string) => ({
        articleId,
        articleSuggestionId: null,
        articleUrl: articleId ? null : `https://example.com/${title}`,
        publicationName: 'The Hindu',
        countryCode: 'IND',
        titleEn: title,
        titleOriginal: null,
        languageCode: 'en',
        imageUrl: null,
        pubDate: null,
        visitedAt: 1,
        visitCount: 1,
    });

    beforeEach(() => {
        mockProfile = { state: 'ready', profile: PROFILE, retry: jest.fn() };
    });

    it('sits beside Latest and Top headlines and switches with setParams', () => {
        const { getByTestId } = renderPage();
        expect(getByTestId('publication-order-history').props.accessibilityState).toEqual({ selected: false });
        fireEvent.press(getByTestId('publication-order-history'));
        expect(mockSetParams).toHaveBeenCalledWith({ order: 'HISTORY' });
    });

    it('selected: only History is marked, the news stays requested as Latest', () => {
        const { getByTestId } = renderPage({ order: 'HISTORY' });
        expect(getByTestId('publication-order-history').props.accessibilityState).toEqual({ selected: true });
        expect(getByTestId('publication-order-latest').props.accessibilityState).toEqual({ selected: false });
        expect(getByTestId('publication-order-top').props.accessibilityState).toEqual({ selected: false });
        expect(mockNewsArgs[0].slice(0, 2)).toEqual(['pub-1', 'NEWEST']);
    });

    it('reads the history only while History is shown on a focused page, by every known name', () => {
        renderPage();
        expect(mockHistoryArgs[mockHistoryArgs.length - 1][1]).toBe(false);
        renderPage({ order: 'HISTORY' });
        const [names, enabled] = mockHistoryArgs[mockHistoryArgs.length - 1] as [string[], boolean];
        expect(enabled).toBe(true);
        expect(names).toEqual(expect.arrayContaining(['The Hindu', 'The Hindu Business Line']));
        mockFocused = false;
        renderPage({ order: 'HISTORY' });
        expect(mockHistoryArgs[mockHistoryArgs.length - 1][1]).toBe(false);
    });

    it('lists the visits, and a row opens its article; one with no article id does nothing', () => {
        mockNews = { ...mockNews, state: 'ready', articles: [article('n1')] };
        mockHistory = { ...mockHistory, visits: [visit('a1', 'Seen'), visit(null, 'Old')] };
        const { getByTestId, queryByTestId, getByText } = renderPage({ order: 'HISTORY' });
        expect(queryByTestId('row-n1')).toBeNull();
        expect(getByText('Seen')).toBeTruthy();
        fireEvent.press(getByTestId('row-a1'));
        expect(mockOpenArticle).toHaveBeenCalledWith({ articleId: 'a1' });
        mockOpenArticle.mockClear();
        fireEvent.press(getByTestId('row-https://example.com/Old'));
        expect(mockOpenArticle).not.toHaveBeenCalled();
    });

    it('empty: an honest title and body; loading: a spinner', () => {
        const empty = renderPage({ order: 'HISTORY' });
        expect(empty.getByText('publicationPage.historyEmptyTitle')).toBeTruthy();
        expect(empty.getByText('publicationPage.historyEmptyBody')).toBeTruthy();
        mockHistory = { ...mockHistory, state: 'loading' };
        expect(renderPage({ order: 'HISTORY' }).getByTestId('publication-history-loading')).toBeTruthy();
    });

    it('is offered even when the news is not (unknown publication)', () => {
        mockProfile = { state: 'notFound', profile: null, retry: jest.fn() };
        const { getByTestId, queryByTestId } = renderPage({ publisherId: null });
        expect(getByTestId('publication-order-history')).toBeTruthy();
        expect(queryByTestId('publication-order-top')).toBeNull();
    });

    it('pull to refresh re-reads the history, and the end of the list loads no news', () => {
        const loadMore = jest.fn();
        mockNews = { ...mockNews, state: 'ready', articles: [article('a1')], hasMore: true, loadMore };
        mockHistory = { ...mockHistory, visits: [visit('a1', 'Seen')] };
        renderPage({ order: 'HISTORY' });
        mockLastList.onEndReached();
        expect(loadMore).not.toHaveBeenCalled();
        mockLastList.refreshControl.props.onRefresh();
        expect(mockReloadHistory).toHaveBeenCalled();
        expect(mockNews.refresh).not.toHaveBeenCalled();
    });
});
