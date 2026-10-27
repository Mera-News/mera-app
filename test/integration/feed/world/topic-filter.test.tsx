// The World topic pill and sheet. Real: WorldPages, WorldTopicPill, ScopeArticleList header, the
// hook, ArticleService, Apollo and MSW. Faked at the edges: the pager (TabPages renders the chosen
// page), the sheet primitive (its onClosed is fired by the test), the pages list, reanimated, cards.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { graphql, HttpResponse, initI18nEn, mockGql, server } from '@/test/helpers';
import { __resetExploreWindowSupport, __resetWorldTopicsSupport } from '@/lib/article-service';
import { useNetworkStore } from '@/lib/stores/network-store';

let mockClosed: (() => void) | undefined;
jest.mock('@/components/ui/bottom-sheet', () => {
    const { View } = jest.requireActual('react-native');
    const R = jest.requireActual('react');
    return {
        BottomSheet: ({ open, onClosed, children, testID }: any) => {
            mockClosed = onClosed;
            return open ? R.createElement(View, { testID }, children) : null;
        },
    };
});
jest.mock('react-native-reanimated', () => {
    const { FlatList, View } = jest.requireActual('react-native');
    const R = jest.requireActual('react');
    return {
        useSharedValue: (v: unknown) => R.useRef({ value: v }).current,
        __esModule: true,
        default: { View, FlatList },
        useAnimatedScrollHandler: () => () => {},
        useComposedEventHandler: () => () => {},
        runOnJS: (f: unknown) => f,
    };
});
jest.mock('@/components/custom/toast/IndeterminateBar', () => () => null);
jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => ({ ArticleStandaloneCompactCard: () => null }));
jest.mock('@/lib/explore/world-pages', () => {
    const scope = (id: string, label: string, a3: string | null) => ({ id, kind: id === 'world' ? 'world' : 'country', label, icon: 'flag', countryCodeAlpha3: a3 });
    const pages = [
        { id: 'world', scope: scope('world', '', null), origin: 'world' },
        { id: 'country:NL', scope: scope('country:NLD', 'Netherlands', 'NLD'), origin: 'browse' },
    ];
    return { useWorldPages: () => ({ pages, loaded: true }), addWorldCountry: jest.fn(), removeWorldCountry: jest.fn() };
});
jest.mock('@/lib/navigation/page-order', () => ({ setWorldPageOrder: jest.fn() }));
jest.mock('@/components/custom/nav/TabPages', () => {
    const R = jest.requireActual('react');
    const { View, Pressable, Text } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ pages, renderPage }: any) => {
            const [cur, setCur] = R.useState(pages[0].id);
            return R.createElement(
                View,
                null,
                ...pages.map((p: any) =>
                    R.createElement(Pressable, { key: p.id, testID: `go-${p.id}`, onPress: () => setCur(p.id) }, R.createElement(Text, null, p.id)),
                ),
                R.createElement(R.Fragment, { key: cur }, renderPage({ pageId: cur, active: true, header: { headerHeight: 0, scrollHandler: () => {} } })),
            );
        },
    };
});

import { WorldPages } from '@/components/custom/world/WorldPages';

const TOPICS = [
    { __typename: 'CanonicalTopic', id: 'ct-politics', path: '/Politics', label: 'Politics', level: 1, parentId: null },
    { __typename: 'CanonicalTopic', id: 'ct-sports', path: '/Sports', label: 'Sports', level: 1, parentId: null },
    { __typename: 'CanonicalTopic', id: 'ct-ref', path: '/Reference', label: 'Reference', level: 1, parentId: null },
];
const facet = (topicId: string, count: number) => ({ __typename: 'CanonicalTopicFacet', topicId, count });
let facetsFor: (code: string) => unknown[];
let sent: { code: string; ids?: string[] }[];

function install() {
    server.use(
        mockGql('GetCanonicalTopics', { canonicalTopics: TOPICS }),
        graphql.operation(({ operationName, variables }) => {
            if (operationName !== 'GetWorldHeadlines') return undefined;
            sent.push({ code: variables.countryCode as string, ids: variables.canonicalTopicIds as string[] | undefined });
            return HttpResponse.json({
                data: {
                    worldHeadlines: {
                        __typename: 'WorldHeadlinesResponse',
                        headlines: [],
                        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
                        editionBuiltAt: null,
                        facets: facetsFor(variables.countryCode as string),
                    },
                },
            });
        }),
    );
}

async function pickRow(slug: string) {
    fireEvent.press(await screen.findByTestId('world-topic-pill'));
    fireEvent.press(await screen.findByTestId(`world-topic-row-${slug}`));
    act(() => mockClosed?.());
}

beforeAll(initI18nEn);
beforeEach(() => {
    __resetExploreWindowSupport();
    __resetWorldTopicsSupport();
    sent = [];
    mockClosed = undefined;
    useNetworkStore.setState({ isConnected: true, serverReachable: true } as never);
    facetsFor = (code) =>
        code === 'NLD' ? [facet('ct-sports', 3)] : [facet('ct-politics', 4), facet('ct-sports', 2), facet('ct-ref', 9)];
    install();
});

it('picking applies only after the sheet has closed, and the sheet hides Reference', async () => {
    render(<WorldPages />);
    fireEvent.press(await screen.findByTestId('world-topic-pill'));
    expect(await screen.findByTestId('world-topic-row-politics')).toBeTruthy();
    expect(screen.queryByTestId('world-topic-row-reference')).toBeNull();
    fireEvent.press(screen.getByTestId('world-topic-row-politics'));
    expect(sent.some((s) => s.ids?.length)).toBe(false);
    expect(screen.queryByTestId('world-topic-clear')).toBeNull();
    act(() => mockClosed?.());
    await waitFor(() => expect(sent.at(-1)?.ids).toEqual(['ct-politics']));
    expect(await screen.findByTestId('world-topic-clear')).toBeTruthy();
    expect(await screen.findByText('4 stories about Politics')).toBeTruthy();
});

it('a country switch keeps the pick when that page has it', async () => {
    render(<WorldPages />);
    await pickRow('sports');
    await screen.findByText('2 stories about Sports');
    fireEvent.press(screen.getByTestId('go-country:NL'));
    expect(await screen.findByText('3 stories about Sports')).toBeTruthy();
});

it('a country switch falls back with the line when that page lacks the pick', async () => {
    render(<WorldPages />);
    await pickRow('politics');
    await screen.findByText('4 stories about Politics');
    fireEvent.press(screen.getByTestId('go-country:NL'));
    expect(await screen.findByText('No Politics stories here right now, so this shows all topics.')).toBeTruthy();
    expect(screen.getByTestId('world-topic-clear')).toBeTruthy();
});

it('clear returns to All', async () => {
    render(<WorldPages />);
    await pickRow('politics');
    fireEvent.press(await screen.findByTestId('world-topic-clear'));
    await waitFor(() => expect(screen.queryByTestId('world-topic-clear')).toBeNull());
    await waitFor(() => expect(sent.at(-1)?.ids).toBeUndefined());
});

it('the latch hides the pill', async () => {
    server.use(
        graphql.operation(({ operationName }) =>
            operationName === 'GetWorldHeadlines'
                ? HttpResponse.json({ errors: [{ message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] })
                : undefined,
        ),
    );
    render(<WorldPages />);
    await screen.findByTestId('explore-list');
    await waitFor(() => expect(sent.length).toBe(0));
    await act(async () => {});
    expect(screen.queryByTestId('world-topic-pill')).toBeNull();
});

it('the latch firing under a pick resets to All', async () => {
    render(<WorldPages />);
    await pickRow('politics');
    await screen.findByTestId('world-topic-clear');
    server.use(
        graphql.operation(({ operationName, variables }) =>
            operationName === 'GetWorldHeadlines' && variables.countryCode === 'NLD'
                ? HttpResponse.json({ errors: [{ message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] })
                : undefined,
        ),
    );
    fireEvent.press(screen.getByTestId('go-country:NL'));
    await waitFor(() => expect(screen.queryByTestId('world-topic-pill')).toBeNull());
    expect(screen.queryByTestId('world-topic-clear')).toBeNull();
});

it('is hidden offline', async () => {
    useNetworkStore.setState({ isConnected: false } as never);
    render(<WorldPages />);
    await screen.findByTestId('explore-list');
    await act(async () => {});
    expect(screen.queryByTestId('world-topic-pill')).toBeNull();
});

it('is hidden when every facet is zero', async () => {
    facetsFor = () => [facet('ct-politics', 0), facet('ct-sports', 0)];
    render(<WorldPages />);
    await screen.findByTestId('explore-list');
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByTestId('world-topic-pill')).toBeNull();
});

it('a page still loading never shows the previous page counts', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
        graphql.operation(async ({ operationName, variables }) => {
            if (operationName !== 'GetWorldHeadlines' || variables.countryCode !== 'NLD') return undefined;
            await gate;
            return undefined; // fall through to install()'s handler
        }),
    );
    render(<WorldPages />);
    await screen.findByTestId('world-topic-pill');
    fireEvent.press(screen.getByTestId('go-country:NL'));
    await waitFor(() => expect(screen.queryByTestId('world-topic-pill')).toBeNull());
    await act(async () => release());
    fireEvent.press(await screen.findByTestId('world-topic-pill'));
    expect(await screen.findByTestId('world-topic-row-sports')).toBeTruthy();
    expect(screen.queryByTestId('world-topic-row-politics')).toBeNull();
});
