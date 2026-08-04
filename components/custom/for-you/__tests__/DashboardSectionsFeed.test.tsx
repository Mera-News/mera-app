/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import type { FactRow, FactRowGroup } from '@/lib/stores/fact-rows-selector';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...args: any[]) => mockRouterPush(...args) },
}));

// Controllable visits map for the section-visits store selector.
let mockVisits: Record<string, number> = {};
jest.mock('@/lib/stores/section-visits-store', () => ({
    useSectionVisitsStore: (selector: any) => selector({ visits: mockVisits }),
}));

// Reanimated: render Animated.FlatList as header + items (or empty), and stub
// the scroll-handler hooks so composition doesn't crash.
jest.mock('react-native-reanimated', () => {
    const ReactLib = require('react');
    const asNode = (c: any) =>
        c == null ? null : ReactLib.isValidElement(c) ? c : ReactLib.createElement(c);
    const FlatListMock = ({
        data,
        renderItem,
        keyExtractor,
        ListHeaderComponent,
        ListEmptyComponent,
    }: any) => {
        const items = data ?? [];
        const kids: any[] = [];
        const header = asNode(ListHeaderComponent);
        if (header) kids.push(ReactLib.createElement(ReactLib.Fragment, { key: 'lh' }, header));
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
        return ReactLib.createElement(ReactLib.Fragment, null, kids);
    };
    return {
        __esModule: true,
        default: { FlatList: FlatListMock },
        useAnimatedScrollHandler: () => ({}),
        useComposedEventHandler: () => ({}),
        useSharedValue: (initial: any) => ({ value: initial }),
        runOnJS: (fn: any) => fn,
    };
});

// The tab-press hook needs a real navigator (useNavigation/useRoute); its own
// behaviour is covered in lib/hooks/__tests__/use-tab-press-scroll-refresh.test.ts.
jest.mock('@/lib/hooks/use-tab-press-scroll-refresh', () => ({
    useTabPressScrollRefresh: jest.fn(),
}));

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (props: any) => <View {...props} /> };
});

// Isolate the feed's own logic — mock the section pieces to render identifiable
// nodes that expose the props DashboardSectionsFeed computes/passes.
jest.mock('@/components/custom/for-you/SectionGradientPanel', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: ({ children }: any) => <View>{children}</View> };
});
jest.mock('@/components/custom/for-you/FactSectionHeader', () => {
    const { Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ title, total, onPress, prefix, translateTitle }: any) => (
            <Pressable accessibilityLabel={`header:${title}`} onPress={onPress}>
                <Text>{`total:${total}`}</Text>
                <Text>
                    {`prefix:${prefix === null ? 'none' : 'default'}/translate:${translateTitle !== false}`}
                </Text>
            </Pressable>
        ),
    };
});
// Headline sections' one-line denominator (P5). Mocked like every other section
// piece — it pulls in the gluestack Text, whose ESM deps jest does not transform.
jest.mock('@/components/custom/for-you/SectionDenominatorLine', () => {
    const { Text } = require('react-native');
    return {
        __esModule: true,
        default: ({ read, shown }: any) => <Text>{`denom:${read}/${shown}`}</Text>,
    };
});
jest.mock('@/components/custom/for-you/SectionViewAllText', () => {
    const { Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ total, onPress }: any) => (
            <Pressable accessibilityLabel="viewall" onPress={onPress}>
                <Text>{`viewall:${total}`}</Text>
            </Pressable>
        ),
    };
});
jest.mock('@/components/custom/cards/ArticleSuggestionCompactCard', () => {
    const { Text, Pressable } = require('react-native');
    return {
        ArticleSuggestionCompactCard: ({ suggestion, onPress }: any) => (
            <Pressable onPress={() => onPress(suggestion)}>
                <Text>{`card:${suggestion._id}`}</Text>
            </Pressable>
        ),
    };
});
jest.mock('@/components/custom/for-you/BreakingStrip', () => ({
    __esModule: true,
    default: () => null,
}));
// Same reason as BreakingStrip: it's list-header chrome this suite doesn't
// assert on. It also reaches MeraLogo, whose `createAnimatedComponent(G)` the
// reanimated mock above deliberately doesn't provide.
jest.mock('@/components/custom/subscription/CompanionModeCard', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import DashboardSectionsFeed from '../DashboardSectionsFeed';

function makeGroup(
    id: string,
    addedMs: number,
    createdAtMs: number,
    relevance = 0.6,
): FactRowGroup {
    return {
        data: {
            _id: id,
            articleId: `art-${id}`,
            relevance,
            publication_name: `pub-${id}`,
            eventType: null,
        } as any,
        members: [],
        rawScore: null,
        bucket: 'MEDIUM' as any,
        pubDateMs: createdAtMs,
        addedMs,
        createdAtMs,
        highPriority: false,
    };
}

function makeRow(factId: string, groups: FactRowGroup[]): FactRow {
    return {
        factId,
        statement: `Statement ${factId}`,
        factStatement: null,
        latestAddedMs: 0,
        unreadCount: 0,
        groups,
    };
}

const noopHandler = {} as any;

const EMPTY_SNAPSHOT = { cardStates: {}, openedArticleIds: new Set<string>() };

function renderFeed(rows: FactRow[], overrides: Record<string, any> = {}) {
    return render(
        <DashboardSectionsFeed
            breaking={[]}
            rows={rows}
            openedIds={new Set()}
            sortSnapshot={EMPTY_SNAPSHOT}
            onPressSuggestion={jest.fn()}
            scrollHandler={noopHandler}
            headerHeight={100}
            {...overrides}
        />,
    );
}

describe('DashboardSectionsFeed', () => {
    beforeEach(() => {
        mockRouterPush.mockClear();
    });

    it('renders one section: header + 3 preview cards + closing view-all row', () => {
        const groups = [
            makeGroup('g1', 5000, 5000),
            makeGroup('g2', 4000, 4000),
            makeGroup('g3', 3000, 3000),
            makeGroup('g4', 2000, 2000),
            makeGroup('g5', 1000, 1000),
        ];
        const { getAllByText, getByText, getByLabelText } = renderFeed([makeRow('f1', groups)]);
        expect(getByLabelText('header:Statement f1')).toBeTruthy();
        expect(getAllByText(/^card:/)).toHaveLength(3);
        // Header pill and closing row both show the section TOTAL.
        expect(getByText('total:5')).toBeTruthy();
        expect(getByText('viewall:5')).toBeTruthy();
    });

    // Previously the footer only rendered when a section had MORE than 3
    // articles, so a one-article section looked broken next to its siblings.
    // The closing row is now unconditional.
    it('renders the closing row even for a section that fits in the preview', () => {
        const { getAllByText, getByText, getByLabelText } = renderFeed([
            makeRow('f1', [makeGroup('g1', 1000, 1000), makeGroup('g2', 900, 900)]),
        ]);
        expect(getAllByText(/^card:/)).toHaveLength(2);
        expect(getByLabelText('viewall')).toBeTruthy();
        expect(getByText('viewall:2')).toBeTruthy();
    });

    it('navigates to the fact feed when the header is pressed', () => {
        const { getByLabelText } = renderFeed([makeRow('f1', [makeGroup('g1', 1000, 1000)])]);
        fireEvent.press(getByLabelText('header:Statement f1'));
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/logged-in/fact-feed',
            params: { factId: 'f1', statement: 'Statement f1' },
        });
    });

    it('navigates to the fact feed when the closing row is pressed', () => {
        const { getByLabelText } = renderFeed([makeRow('f1', [makeGroup('g1', 1000, 1000)])]);
        fireEvent.press(getByLabelText('viewall'));
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/logged-in/fact-feed',
            params: { factId: 'f1', statement: 'Statement f1' },
        });
    });

    // The preview is the top 3 of the SHARED priority order (unviewed
    // high→med→low, then viewed) — not a separate ranking, and not a
    // pre-filtered "unopened only" list.
    it('previews the top 3 by the shared priority order', () => {
        const groups = [
            makeGroup('low', 1000, 1000, 0.4),
            makeGroup('high', 2000, 2000, 0.9),
            makeGroup('med', 3000, 3000, 0.6),
            makeGroup('irrelevant', 4000, 4000, 0.1),
        ];
        const { getAllByText } = renderFeed([makeRow('f1', groups)]);
        expect(getAllByText(/^card:/).map((n: any) => n.props.children)).toEqual([
            'card:high',
            'card:med',
            'card:low',
        ]);
    });

    it('sinks viewed stories below unviewed ones, whatever their relevance', () => {
        const groups = [
            makeGroup('viewed-high', 1000, 1000, 0.9),
            makeGroup('unviewed-low', 2000, 2000, 0.4),
        ];
        const { getAllByText } = renderFeed([makeRow('f1', groups)], {
            sortSnapshot: {
                cardStates: {},
                openedArticleIds: new Set(['art-viewed-high']),
            },
        });
        expect(getAllByText(/^card:/).map((n: any) => n.props.children)).toEqual([
            'card:unviewed-low',
            'card:viewed-high',
        ]);
    });
});

// ── Headline sections (P5) ──────────────────────────────────────────────────
// Top-headline rows already reached the device and already rendered on the Feed
// tab; the Dashboard dropped them. They now get a section per scope, whose ONE
// line of text states how many headlines Mera read versus how many were worth
// the reader's time — and which, uniquely, still renders when that second
// number is zero.

function makeHeadlineRow(
    factId: string,
    kind: 'headline-country' | 'headline-global',
    read: number,
    groups: FactRowGroup[],
    countryCode: string | null = null,
): FactRow {
    return {
        factId,
        kind,
        countryCode,
        headlineReadCount: read,
        statement: '',
        factStatement: null,
        latestAddedMs: 0,
        unreadCount: 0,
        groups,
    };
}

describe('DashboardSectionsFeed — headline sections', () => {
    beforeEach(() => {
        mockRouterPush.mockClear();
    });

    it('renders the denominator line with read vs shown', () => {
        const { getByText } = renderFeed([
            makeHeadlineRow('headline-country-in', 'headline-country', 20, [
                makeGroup('g1', 3000, 3000),
                makeGroup('g2', 2000, 2000),
                makeGroup('g3', 1000, 1000),
            ], 'IN'),
        ]);
        expect(getByText('denom:20/3')).toBeTruthy();
    });

    it('still renders title + line, and NO cards or view-all, when nothing cleared the bar', () => {
        const { getByText, queryAllByText, queryByLabelText, getByLabelText } = renderFeed([
            makeHeadlineRow('headline-global', 'headline-global', 20, []),
        ]);
        expect(getByLabelText('header:forYou.headlineSectionGlobal')).toBeTruthy();
        expect(getByText('denom:20/0')).toBeTruthy();
        expect(queryAllByText(/^card:/)).toHaveLength(0);
        // No "View all" pointing at an empty list — the line IS the content.
        expect(queryByLabelText('viewall')).toBeNull();
    });

    it('drops the "News about:" prefix and does not re-translate the title', () => {
        const { getByText } = renderFeed([
            makeHeadlineRow('headline-global', 'headline-global', 5, [makeGroup('g1', 1, 1)]),
        ]);
        expect(getByText('prefix:none/translate:false')).toBeTruthy();
    });

    it('keeps the fact-section chrome untouched', () => {
        const { getByText, queryByText } = renderFeed([makeRow('f1', [makeGroup('g1', 1, 1)])]);
        expect(getByText('prefix:default/translate:true')).toBeTruthy();
        expect(queryByText(/^denom:/)).toBeNull();
    });

    it('opens the section feed with the LOCALIZED title, not the empty statement', () => {
        const { getByLabelText } = renderFeed([
            makeHeadlineRow('headline-country-in', 'headline-country', 8, [
                makeGroup('g1', 1, 1),
            ], 'IN'),
        ]);
        fireEvent.press(getByLabelText('viewall'));
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/logged-in/fact-feed',
            params: {
                factId: 'headline-country-in',
                statement: 'forYou.headlineSectionCountry',
            },
        });
    });
});
