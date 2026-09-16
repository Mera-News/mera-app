/* eslint-disable @typescript-eslint/no-require-imports */
// The per-publication read history used to open the publisher URL straight from
// the row. That skipped the detail screen — the ONLY place the translate
// affordance (ReadTranslateActions) lives — so a reader whose language differs
// from the article's landed on an untranslated page with no way back to the
// translate options. History rows now navigate to the detail screen like every
// other surface, and the screen owns opening the URL.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

jest.mock('react-native', () => {
    const ReactLib = require('react');
    const host = (name: string) => (props: any) =>
        ReactLib.createElement(name, props, props.children);
    const View = host('View');
    return {
        __esModule: true,
        View,
        Text: host('Text'),
        RefreshControl: (props: any) => ReactLib.createElement(View, props),
        Pressable: host('View'),
        // ListHeaderComponent is RENDERED, not dropped. It used to be
        // ignored here, which made every "the header is absent" assertion
        // pass for the wrong reason: the mock never drew a header at all, so
        // a gate that was wide open would still have looked shut.
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) =>
            ReactLib.createElement(
                ReactLib.Fragment,
                null,
                ReactLib.isValidElement(ListHeaderComponent)
                    ? ListHeaderComponent
                    : typeof ListHeaderComponent === 'function'
                      ? ReactLib.createElement(ListHeaderComponent)
                      : null,
                (data ?? []).map((item: any, index: number) =>
                    ReactLib.createElement(
                        ReactLib.Fragment,
                        { key: keyExtractor ? keyExtractor(item, index) : index },
                        renderItem({ item, index }),
                    ),
                ),
            ),
        Platform: { OS: 'ios', select: (o: any) => o.ios },
        StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
    };
});

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('../DrillDownHeader', () => { const { View } = require('react-native'); return { __esModule: true, default: (p: any) => <View {...p} /> }; });

// The row is stubbed down to a pressable proxy: this file is about WHERE a tap
// goes, not how the card looks.
jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => {
    const { View } = require('react-native');
    return {
        ArticleStandaloneCompactCard: (p: any) => (
            <View testID={`card-${p.article._id}`} onPress={p.onPress} />
        ),
    };
});

const mockOpenArticle = jest.fn();
jest.mock('@/lib/hooks/use-open-article', () => ({ useOpenArticle: () => mockOpenArticle }));

// Guard: the whole point of the change is that NO browser opens from here. The
// module is mocked so an accidental re-introduction shows up as a call, not as
// an unresolved import.
const mockOpenArticleInAppBrowser = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/web-browser-utils', () => ({
    openArticleInAppBrowser: (...a: any[]) => mockOpenArticleInAppBrowser(...a),
}));

const mockGetVisitsForPublication = jest.fn();
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getVisitsForPublication: (...a: any[]) => mockGetVisitsForPublication(...a),
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

// `use-subscribe-flow` opens a WatermelonDB observation and an AppState
// listener; `SubscribeConfirmDialog` pulls `@/components/ui/modal` and
// through it `@legendapp/motion`, which this suite's RN mock cannot load.
// The real `SubscribeAction` is deliberately left unmocked so these suites
// still render the affordance itself.
const mockSubscribeBegin = jest.fn();
const mockConfirmDirectly = jest.fn();
let mockIsSubscribed = (_id: string) => false;
jest.mock('@/components/custom/publication-preferences/use-subscribe-flow', () => ({
    useSubscribeFlow: () => ({
        subscriptions: { items: [], isLoading: false, busyId: null },
        begin: mockSubscribeBegin,
        confirmDirectly: mockConfirmDirectly,
        confirming: null,
        onYes: jest.fn(),
        onNo: jest.fn(),
        isSubscribed: (id: string) => mockIsSubscribed(id),
    }),
}));
jest.mock('@/components/custom/publication-preferences/SubscribeConfirmDialog', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => { const { View, Text } = require('react-native'); return { Button: (p: any) => <View {...p} />, ButtonText: (p: any) => <Text {...p} /> }; });

// The name -> publisher resolution. Default is "no publisher", which is the
// branch that must leave this screen byte-identical to before.
const mockResolvePublisher = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/subscriptions/publisher-lookup', () => ({
    resolvePublisherForSourceName: (...args: any[]) => mockResolvePublisher(...args),
}));


import PublicationArticleHistoryList from '../PublicationArticleHistoryList';

const makeVisit = (overrides: Record<string, unknown> = {}) => ({
    articleId: 'art-1',
    articleSuggestionId: null,
    articleUrl: 'https://zeit.de/story',
    publicationName: 'Die Zeit',
    countryCode: 'DEU',
    titleEn: 'English headline',
    titleOriginal: 'Deutsche Schlagzeile',
    languageCode: 'de',
    imageUrl: null,
    pubDate: 1700000000000,
    visitedAt: 1700000100000,
    visitCount: 1,
    ...overrides,
});

const renderList = () =>
    render(
        <PublicationArticleHistoryList
            publicationName="Die Zeit"
            countryCode="DEU"
            onBack={jest.fn()}
        />,
    );

beforeEach(() => {
    jest.clearAllMocks();
    mockGetVisitsForPublication.mockResolvedValue([makeVisit()]);
});

describe('PublicationArticleHistoryList — a tap goes to the detail screen', () => {
    it('routes the row to the detail screen by article id', async () => {
        const { findByTestId } = renderList();
        fireEvent.press(await findByTestId('card-art-1'));
        expect(mockOpenArticle).toHaveBeenCalledWith({ articleId: 'art-1' });
    });

    it('never opens the publisher URL itself — that would skip the translate options', async () => {
        const { findByTestId } = renderList();
        fireEvent.press(await findByTestId('card-art-1'));
        await waitFor(() => expect(mockOpenArticleInAppBrowser).not.toHaveBeenCalled());
    });

    it('is inert for a row with no article id rather than routing a URL as one', async () => {
        // `articleId` is nullable on the row but not in practice (every current
        // caller of recordPublicationVisit passes one). Routing `articleUrl` in
        // its place would land a URL in the saved / visit tables, which key off
        // that same param — so the row simply does nothing.
        mockGetVisitsForPublication.mockResolvedValue([
            makeVisit({ articleId: null }),
        ]);
        const { findByTestId } = renderList();
        fireEvent.press(await findByTestId('card-https://zeit.de/story'));
        expect(mockOpenArticle).not.toHaveBeenCalled();
        expect(mockOpenArticleInAppBrowser).not.toHaveBeenCalled();
    });
});

describe('PublicationArticleHistoryList — the publisher subscribe card', () => {
    const PUBLISHER = {
        publisherId: 'pub-zeit',
        publisherName: 'Die Zeit',
        countryCode: 'DEU',
        subscriptionUri: 'https://www.zeit.de/abo',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockIsSubscribed = () => false;
        mockGetVisitsForPublication.mockResolvedValue([makeVisit()]);
        mockResolvePublisher.mockResolvedValue(null);
    });

    it('renders NOTHING when the name resolves to no publisher', async () => {
        const { queryByTestId } = renderList();
        await waitFor(() => expect(mockResolvePublisher).toHaveBeenCalled());
        expect(queryByTestId('publication-history-subscribe')).toBeNull();
    });

    it('renders NOTHING when the publisher has no subscribe page', async () => {
        // Null is a first-class value meaning "no consumer subscription
        // product", not missing data. It must never draw a dead button.
        mockResolvePublisher.mockResolvedValue({ ...PUBLISHER, subscriptionUri: null });
        const { queryByTestId } = renderList();
        await waitFor(() => expect(mockResolvePublisher).toHaveBeenCalled());
        expect(queryByTestId('publication-history-subscribe')).toBeNull();
    });

    it('renders NOTHING when the reader already subscribes to this publisher', async () => {
        mockResolvePublisher.mockResolvedValue(PUBLISHER);
        mockIsSubscribed = (id: string) => id === 'pub-zeit';
        const { queryByTestId } = renderList();
        await waitFor(() => expect(mockResolvePublisher).toHaveBeenCalled());
        expect(queryByTestId('publication-history-subscribe')).toBeNull();
    });

    it('renders the card, and asks for the PUBLISHER page, when a real URI resolved', async () => {
        mockResolvePublisher.mockResolvedValue(PUBLISHER);
        const { findByTestId, getByTestId } = renderList();

        fireEvent.press(await findByTestId('publication-history-subscribe'));
        expect(mockSubscribeBegin).toHaveBeenCalledWith(PUBLISHER);

        // The secondary path writes the subscription without a browser trip.
        fireEvent.press(getByTestId('publication-history-subscribe-already'));
        expect(mockConfirmDirectly).toHaveBeenCalledWith(PUBLISHER);
    });

    it('looks the publisher up by the SOURCE name and country it was routed with', async () => {
        renderList();
        await waitFor(() =>
            expect(mockResolvePublisher).toHaveBeenCalledWith('Die Zeit', 'DEU'),
        );
    });
});
