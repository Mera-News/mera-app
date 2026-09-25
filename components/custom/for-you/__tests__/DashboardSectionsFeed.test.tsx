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

// Reanimated: render Animated.FlatList as header + items (or empty) + footer,
// and stub the scroll-handler hooks so composition doesn't crash.
jest.mock('react-native-reanimated', () => {
    const ReactLib = require('react');
    const asNode = (c: any) =>
        c == null ? null : ReactLib.isValidElement(c) ? c : ReactLib.createElement(c);
    const FlatListMock = ({
        data,
        renderItem,
        keyExtractor,
        ListHeaderComponent,
        ListFooterComponent,
        ListEmptyComponent,
        testID,
        contentContainerStyle,
        onContentSizeChange,
    }: any) => {
        const { View } = jest.requireActual('react-native');
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
        // Footer LAST, and rendered even when `data` is empty — both match real
        // FlatList, which draws ListFooterComponent alongside ListEmptyComponent.
        // The mock omitted it entirely for a long time, so any footer this list
        // grows could render nothing while its test still passed. Kept even
        // though the list has no footer today: that silent-pass hazard is the
        // reason to model it, not the presence of a particular footer.
        const footer = asNode(ListFooterComponent);
        if (footer) kids.push(ReactLib.createElement(ReactLib.Fragment, { key: 'lf' }, footer));
        // A View carrying the list's own testID and content style, so a test
        // can read the padding the component handed the list.
        return ReactLib.createElement(View, { testID, contentContainerStyle, onContentSizeChange }, kids);
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
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
    const { Text } = require('react-native');
    return {
        __esModule: true,
        default: ({ body, testID }: any) => <Text testID={testID}>{`empty:${body}`}</Text>,
    };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
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
jest.mock('@/components/custom/for-you/BreakingStrip', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="breaking-strip" /> };
});
// The card has its own suite (auto-hide, zero-count line); here only its
// POSITION in the list matters.
jest.mock('@/components/custom/for-you/DashboardStatsCard', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="dashboard-stats-card" /> };
});
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

    // M4: "View all 1 article" under the one article it named. The closing
    // row renders only when the section holds more than the preview shows;
    // the header's open button still opens every section.
    it('renders no closing row for a section that fits in the preview', () => {
        const { getAllByText, queryByLabelText } = renderFeed([
            makeRow('f1', [makeGroup('g1', 1000, 1000), makeGroup('g2', 900, 900)]),
        ]);
        expect(getAllByText(/^card:/)).toHaveLength(2);
        expect(queryByLabelText('viewall')).toBeNull();
    });

    it('renders no closing row at exactly the preview count', () => {
        const { queryByLabelText } = renderFeed([
            makeRow('f1', [
                makeGroup('g1', 1000, 1000),
                makeGroup('g2', 900, 900),
                makeGroup('g3', 800, 800),
            ]),
        ]);
        expect(queryByLabelText('viewall')).toBeNull();
    });

    it('renders the closing row one past the preview count', () => {
        const { getByText } = renderFeed([
            makeRow('f1', [
                makeGroup('g1', 1000, 1000),
                makeGroup('g2', 900, 900),
                makeGroup('g3', 800, 800),
                makeGroup('g4', 700, 700),
            ]),
        ]);
        expect(getByText('viewall:4')).toBeTruthy();
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
        const { getByLabelText } = renderFeed([
            makeRow('f1', ['g1', 'g2', 'g3', 'g4'].map((id, i) => makeGroup(id, 1000 - i, 1000 - i))),
        ]);
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

    // Owner: no empty sections on the Overview, headline scopes included (the
    // selector already drops a headline scope with no viable story).
    it('draws nothing for a headline section with no stories', () => {
        const { queryByText, queryByLabelText } = renderFeed([
            makeHeadlineRow('headline-global', 'headline-global', 20, []),
        ]);
        expect(queryByLabelText('header:forYou.headlineSectionGlobal')).toBeNull();
        expect(queryByText(/^denom:/)).toBeNull();
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
                makeGroup('g1', 4, 4),
                makeGroup('g2', 3, 3),
                makeGroup('g3', 2, 2),
                makeGroup('g4', 1, 1),
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

// ── Every group renders ────────────────────────────────────────────────────
// A display-only importance dial used to cut `row.groups` before ordering, and
// a section whose every group it hid was dropped outright. Both are gone. These
// pin the replacement rule, which is simply that there is no rule: the preview,
// the total and the "view all" count are all `row.groups`, and a LOW-band story
// reaches the screen like any other.

describe('DashboardSectionsFeed — no importance gate', () => {
    beforeEach(() => {
        mockRouterPush.mockClear();
    });

    it('renders a LOW-band story and counts it in total and view-all', () => {
        const groups = [
            makeGroup('hi', 3000, 3000, 0.9),
            makeGroup('med', 2000, 2000, 0.6),
            makeGroup('lo', 1000, 1000, 0.4),
            makeGroup('lo2', 500, 500, 0.4),
        ];
        const { getAllByText, getByText } = renderFeed([makeRow('f1', groups)]);
        expect(getAllByText(/^card:/).map((n: any) => n.props.children)).toEqual([
            'card:hi',
            'card:med',
            'card:lo',
        ]);
        expect(getByText('total:4')).toBeTruthy();
        expect(getByText('viewall:4')).toBeTruthy();
    });

    it('keeps a section whose only group is LOW band', () => {
        const { getByLabelText, getAllByText } = renderFeed([
            makeRow('f1', [makeGroup('lo', 1000, 1000, 0.4)]),
        ]);
        expect(getByLabelText('header:Statement f1')).toBeTruthy();
        expect(getAllByText(/^card:/)).toHaveLength(1);
    });
});

// Owner (reversing D4): "let's get rid of empty sections ... the experience
// is much better". A section with no stories is not drawn at all on the
// Overview: no header, no placeholder, no "looking for stories" row. Nothing
// is persisted, so it appears as soon as a refresh gives it a story.
describe('DashboardSectionsFeed: empty sections are hidden', () => {
    function emptyRow(factId: string, emptyReason: 'awaiting-first-run' | 'no-match-yet', newInterest = false): FactRow {
        return { ...makeRow(factId, []), emptyReason, newInterest } as FactRow;
    }

    it('draws nothing for an empty section: no header, no placeholder, no reason copy', () => {
        const r = renderFeed([makeRow('f1', [makeGroup('g1', 1, 1)]), emptyRow('f-new', 'awaiting-first-run', true), emptyRow('f-old', 'no-match-yet')]);
        // Presence first: the populated section is drawn.
        expect(r.getByLabelText('header:Statement f1')).toBeTruthy();
        expect(r.queryByLabelText('header:Statement f-new')).toBeNull();
        expect(r.queryByLabelText('header:Statement f-old')).toBeNull();
        expect(r.queryByTestId('dashboard-section-empty-f-new')).toBeNull();
        expect(r.queryByTestId('dashboard-section-new-f-new')).toBeNull();
        expect(r.queryByText(/emptySection/)).toBeNull();
    });

    it('with every section empty, shows the Overview\'s own nothing-yet state and no sections', () => {
        const { Text } = require('react-native');
        const r = renderFeed([emptyRow('f-new', 'awaiting-first-run'), emptyRow('f-old', 'no-match-yet')], {
            ListEmptyComponent: <Text testID="nothing-yet">nothing yet</Text>,
        });
        expect(r.getAllByTestId('nothing-yet')).toHaveLength(1);
        expect(r.queryByLabelText(/^header:/)).toBeNull();
        expect(r.getByTestId('dashboard-stats-card')).toBeTruthy();
    });

    it('draws a section as soon as a refresh gives it a story', () => {
        const r = renderFeed([emptyRow('f-new', 'awaiting-first-run')]);
        expect(r.queryByLabelText('header:Statement f-new')).toBeNull();
        r.rerender(
            <DashboardSectionsFeed
                breaking={[]}
                rows={[makeRow('f-new', [makeGroup('g1', 1, 1)])]}
                openedIds={new Set()}
                sortSnapshot={EMPTY_SNAPSHOT}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        expect(r.getByLabelText('header:Statement f-new')).toBeTruthy();
    });
});

describe('DashboardSectionsFeed: list end padding', () => {
    it('counts the tab bar once (the in-tab inset already includes it on iOS)', () => {
        const { getByTestId } = renderFeed([makeRow('f1', [makeGroup('g1', 1, 1)])]);
        const style = getByTestId('dashboard-feed-list').props.contentContainerStyle;
        expect(style.paddingBottom).toBe(24);
    });
});

describe('DashboardSectionsFeed: the Overview stats card', () => {
    const ids = (r: ReturnType<typeof renderFeed>) =>
        r.UNSAFE_root.findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string').map(
            (n: any) => n.props.testID as string,
        );

    it('is the first card, ahead of the breaking strip and every section', () => {
        const r = renderFeed([makeRow('f1', [makeGroup('g1', 1, 1)])], {
            breaking: [{ id: 'b1' } as any],
        });
        const order = ids(r);
        expect(order.indexOf('dashboard-stats-card')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('dashboard-stats-card')).toBeLessThan(order.indexOf('breaking-strip'));
    });

    it('still leads the nothing-yet state when every section is empty', () => {
        const { Text } = require('react-native');
        const empty = { ...makeRow('f-new', []), emptyReason: 'awaiting-first-run' } as FactRow;
        const r = renderFeed([empty], {
            ListEmptyComponent: <Text testID="nothing-yet">nothing yet</Text>,
        });
        const order = ids(r);
        expect(order.indexOf('dashboard-stats-card')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('dashboard-stats-card')).toBeLessThan(order.indexOf('nothing-yet'));
    });

    it('renders even with no sections at all', () => {
        const r = renderFeed([]);
        expect(r.getByTestId('dashboard-stats-card')).toBeTruthy();
    });
});

// ux2 B3 window: the Overview panel stays mounted as a neighbour of Stories.
// Off-screen it must not feed the translation scheduler's scroll ticks, and a
// Dashboard tab re-tap must not scroll or refresh (a feed sync) through it.
describe('DashboardSectionsFeed: off-screen (active=false)', () => {
    const tabPress = () => require('@/lib/hooks/use-tab-press-scroll-refresh').useTabPressScrollRefresh as jest.Mock;

    it('sends no scroll tick on a content-size change', () => {
        const r = renderFeed([], { active: false, onRefresh: jest.fn() });
        const list = r.UNSAFE_root.findAll((n: any) => n.props?.contentContainerStyle && n.type === 'View')[0];
        expect(list.props.onContentSizeChange).toBeUndefined();
        const opts = tabPress().mock.calls.at(-1)[0];
        expect(opts.onRefresh).toBeUndefined();
        expect(opts.getOffset()).toBe(0);
    });

    it('does all of it when active (the default)', () => {
        const onRefresh = jest.fn();
        const r = renderFeed([], { onRefresh });
        const list = r.UNSAFE_root.findAll((n: any) => n.props?.contentContainerStyle && n.type === 'View')[0];
        expect(typeof list.props.onContentSizeChange).toBe('function');
        expect(tabPress().mock.calls.at(-1)[0].onRefresh).toBe(onRefresh);
    });
});
