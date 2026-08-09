/* eslint-disable @typescript-eslint/no-require-imports */
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as sibling tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

// Plain RN stubs — no FlatList here anymore: the component now renders
// `Animated.FlatList` (see the react-native-reanimated mock below), same
// reason DashboardSectionsFeed.test.tsx mocks reanimated's FlatList instead of
// RN's — RN's real ScrollView-backed FlatList doesn't load in this Jest env.
jest.mock('react-native', () => {
    const ReactLib = require('react');
    const host = (name: string) => (props: any) => ReactLib.createElement(name, props, props.children);
    const View = host('View');
    return {
        __esModule: true,
        View,
        Text: host('Text'),
        RefreshControl: (props: any) => ReactLib.createElement(View, props),
        Platform: { OS: 'ios', select: (o: any) => o.ios },
        StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
    };
});

// Captured from the mocked Animated.FlatList below (assigned during its render,
// like `hookOptions`). `mock`-prefixed because jest's hoisting rule requires it
// for anything a jest.mock factory closes over.
let mockListOnEndReached: (() => Promise<void> | void) | null = null;

// Reanimated: render Animated.FlatList as items (+ refreshControl/empty/footer),
// and stub the scroll-handler hooks so composition doesn't crash. This mock
// also renders the `refreshControl` PROP as a child, which is what lets the
// test read the RefreshControl's wiring back out. Mirrors
// DashboardSectionsFeed.test.tsx's reanimated mock.
jest.mock('react-native-reanimated', () => {
    const ReactLib = require('react');
    const asNode = (c: any) =>
        c == null ? null : ReactLib.isValidElement(c) ? c : ReactLib.createElement(c);
    const FlatListMock = ReactLib.forwardRef(
        (
            {
                data,
                renderItem,
                keyExtractor,
                ListEmptyComponent,
                ListFooterComponent,
                refreshControl,
                onEndReached,
            }: any,
            _ref: any,
        ) => {
            // Exposed so a test can drive pagination — the real list calls this
            // on scroll, which this mock has no notion of.
            mockListOnEndReached = onEndReached;
            const items = data ?? [];
            const kids: any[] = [];
            if (refreshControl) kids.push(ReactLib.createElement(ReactLib.Fragment, { key: 'rc' }, refreshControl));
            if (items.length === 0) {
                const empty = asNode(ListEmptyComponent);
                if (empty) kids.push(ReactLib.createElement(ReactLib.Fragment, { key: 'le' }, empty));
            }
            items.forEach((item: any, index: number) => {
                kids.push(
                    ReactLib.createElement(
                        ReactLib.Fragment,
                        { key: keyExtractor ? keyExtractor(item, index) : index },
                        renderItem({ item, index }),
                    ),
                );
            });
            const footer = asNode(ListFooterComponent);
            if (footer) kids.push(ReactLib.createElement(ReactLib.Fragment, { key: 'lf' }, footer));
            return ReactLib.createElement(ReactLib.Fragment, null, kids);
        },
    );
    return {
        __esModule: true,
        default: { FlatList: FlatListMock },
        useAnimatedScrollHandler: (config: any) => config,
        useComposedEventHandler: () => undefined,
        useSharedValue: (initial: any) => ({ value: initial }),
        runOnJS: (fn: any) => fn,
    };
});

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => {
    const { View } = require('react-native');
    return { ArticleStandaloneCompactCard: (p: any) => <View testID={`card-${p.article._id}`} /> };
});

jest.mock('@/lib/hooks/use-open-article', () => ({ useOpenArticle: () => jest.fn() }));
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn(), info: jest.fn() } }));

// Capture what the screen hands the tab-press hook, so the "the icon re-tap and
// the RefreshControl share ONE handler" contract is asserted rather than assumed.
let hookOptions: any = null;
jest.mock('@/lib/hooks/use-tab-press-scroll-refresh', () => ({
    useTabPressScrollRefresh: (opts: any) => {
        hookOptions = opts;
    },
}));

const mockGetTopHeadlines = jest.fn();
jest.mock('@/lib/article-service', () => ({
    __esModule: true,
    default: {
        getTopHeadlinesForCountry: (...a: unknown[]) => mockGetTopHeadlines(...a),
    },
}));

import ScopeArticleList from '../ScopeArticleList';

const scope = { id: 'world', kind: 'world', countryCodeAlpha3: null } as any;

// The mocked `useComposedEventHandler` above ignores its arguments, so a bare
// stub satisfies the (now required) collapsible-header `scrollHandler` prop
// without needing a real worklet handler in this suite.
const stubScrollHandler = {} as any;

const page = (ids: string[], cursor: string | null, more: boolean) => ({
    headlines: ids.map((id) => ({ article: { _id: id }, stableClusterId: null })),
    pageInfo: { endCursor: cursor, hasNextPage: more },
});

beforeEach(() => {
    jest.clearAllMocks();
    hookOptions = null;
    mockListOnEndReached = null;
});

// Regression: "Encountered two children with the same key" on the Explore tab.
// `topHeadlinesForCountry` paginates by OFFSET into an edition that is rebuilt
// hourly, so a later page can legitimately re-serve rows the client already
// holds. The duplicate ARTICLE is the bug; the key warning is only its symptom,
// so the assertion is that the row renders ONCE — not that its key is unique.
describe('ScopeArticleList — duplicate rows across pages', () => {
    it('drops a page-2 row that is already on screen instead of rendering it twice', async () => {
        mockGetTopHeadlines.mockResolvedValueOnce(page(['a', 'b'], 'cur1', true));
        const { getAllByTestId, getByTestId } = render(
            <ScopeArticleList scope={scope} scrollHandler={stubScrollHandler} />,
        );
        await waitFor(() => expect(getByTestId('card-a')).toBeTruthy());

        // Page 2 overlaps page 1 on 'b' — the edition shifted under the offset.
        mockGetTopHeadlines.mockResolvedValueOnce(page(['b', 'c'], 'cur2', false));
        await act(async () => {
            await mockListOnEndReached!();
        });

        expect(getAllByTestId('card-b')).toHaveLength(1);
        expect(getByTestId('card-c')).toBeTruthy();
        expect(getAllByTestId(/^card-/)).toHaveLength(3);
    });

    it('collapses a repeat WITHIN a single page (edition carrying one article twice)', async () => {
        mockGetTopHeadlines.mockResolvedValueOnce(page(['a', 'a', 'b'], null, false));
        const { getAllByTestId, getByTestId } = render(
            <ScopeArticleList scope={scope} scrollHandler={stubScrollHandler} />,
        );

        await waitFor(() => expect(getByTestId('card-b')).toBeTruthy());
        expect(getAllByTestId('card-a')).toHaveLength(1);
    });

    it('discards an in-flight paginate whose page lands AFTER a refresh', async () => {
        mockGetTopHeadlines.mockResolvedValueOnce(page(['a', 'b'], 'cur1', true));
        const { getByTestId, queryByTestId } = render(
            <ScopeArticleList scope={scope} scrollHandler={stubScrollHandler} />,
        );
        await waitFor(() => expect(getByTestId('card-a')).toBeTruthy());

        // Start page 2 but never settle it.
        let settlePageTwo: ((value: unknown) => void) | null = null;
        mockGetTopHeadlines.mockImplementationOnce(
            () => new Promise((resolve) => { settlePageTwo = resolve; }),
        );
        await act(async () => {
            void mockListOnEndReached!();
        });

        // …then refresh (the tab-icon re-tap path) and let it land.
        mockGetTopHeadlines.mockResolvedValueOnce(page(['z'], 'cur9', false));
        await act(async () => {
            await hookOptions.onRefresh();
        });
        expect(getByTestId('card-z')).toBeTruthy();

        // The stale page 2 now arrives. It belongs to the pre-refresh ordering
        // and must be dropped wholesale, not appended.
        await act(async () => {
            settlePageTwo!(page(['b', 'c'], 'cur2', false));
        });

        expect(getByTestId('card-z')).toBeTruthy();
        expect(queryByTestId('card-c')).toBeNull();
        expect(queryByTestId('card-b')).toBeNull();
    });
});

describe('ScopeArticleList pull-to-refresh', () => {
    it('refetches page 1 WITHOUT a cursor and replaces the list', async () => {
        mockGetTopHeadlines.mockResolvedValueOnce(page(['a', 'b'], 'cur1', true));
        const { getByTestId, queryByTestId } = render(
            <ScopeArticleList scope={scope} scrollHandler={stubScrollHandler} />,
        );

        await waitFor(() => expect(getByTestId('card-a')).toBeTruthy());
        expect(mockGetTopHeadlines).toHaveBeenCalledWith('GLOBAL', { first: 10, after: undefined });

        // The refreshed page must REPLACE, not append — a ranked server feed
        // stitched onto stale later pages would duplicate rows.
        mockGetTopHeadlines.mockResolvedValueOnce(page(['c'], 'cur2', false));
        await act(async () => {
            await hookOptions.onRefresh();
        });

        expect(mockGetTopHeadlines).toHaveBeenLastCalledWith('GLOBAL', { first: 10, after: undefined });
        await waitFor(() => expect(getByTestId('card-c')).toBeTruthy());
        expect(queryByTestId('card-a')).toBeNull();
    });

    it('wires the SAME handler into the RefreshControl and the tab-press hook', async () => {
        mockGetTopHeadlines.mockResolvedValueOnce(page(['a'], null, false));
        const { getByTestId } = render(
            <ScopeArticleList scope={scope} scrollHandler={stubScrollHandler} />,
        );
        await waitFor(() => expect(getByTestId('card-a')).toBeTruthy());

        const control = getByTestId('explore-refresh');
        // One handler, one in-flight flag — otherwise the two entry points could
        // each start a refresh while the other was already running.
        expect(control.props.onRefresh).toBe(hookOptions.onRefresh);
        expect(control.props.refreshing).toBe(hookOptions.isRefreshing);
    });

    it('does not refresh while the query is gated (enabled=false)', async () => {
        render(<ScopeArticleList scope={scope} enabled={false} scrollHandler={stubScrollHandler} />);
        expect(mockGetTopHeadlines).not.toHaveBeenCalled();

        await act(async () => {
            await hookOptions.onRefresh();
        });
        expect(mockGetTopHeadlines).not.toHaveBeenCalled();
    });
});
