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
        runOnJS: (fn: any) => fn,
    };
});

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
        // Mirror the real component's press rule: provisional headers are never
        // pressable (no fact feed behind them) — rendered as a static Text with a
        // distinct label so tests can assert non-navigability.
        default: ({ title, newCount, onPress, kind }: any) => {
            const canPress = kind !== 'provisional' && !!onPress;
            return canPress ? (
                <Pressable accessibilityLabel={`header:${kind}:${title}`} onPress={onPress}>
                    <Text>{`new:${newCount}`}</Text>
                </Pressable>
            ) : (
                <Text accessibilityLabel={`statichdr:${kind}:${title}`}>{`new:${newCount}`}</Text>
            );
        },
    };
});
jest.mock('@/components/custom/for-you/SectionViewAllRow', () => {
    const { Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ total, onPress }: any) => (
            <Pressable accessibilityLabel="footer" onPress={onPress}>
                <Text>{`footer:${total}`}</Text>
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

import DashboardSectionsFeed from '../DashboardSectionsFeed';

function makeGroup(id: string, addedMs: number, createdAtMs: number): FactRowGroup {
    return {
        data: { _id: id, publication_name: `pub-${id}`, eventType: null } as any,
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
        kind: 'fact',
        statement: `Statement ${factId}`,
        factStatement: null,
        latestAddedMs: 0,
        unreadCount: 0,
        hasUnreadHighPriority: false,
        groups,
    };
}

const noopHandler = {} as any;

describe('DashboardSectionsFeed', () => {
    beforeEach(() => {
        mockRouterPush.mockClear();
        mockVisits = {};
    });

    it('renders header + 3 preview cards + footer for a 5-group section', () => {
        const groups = [
            makeGroup('g1', 5000, 5000),
            makeGroup('g2', 4000, 4000),
            makeGroup('g3', 3000, 3000),
            makeGroup('g4', 2000, 2000),
            makeGroup('g5', 1000, 1000),
        ];
        const rows = [makeRow('f1', groups)];
        const { getAllByText, getByText, getByLabelText } = render(
            <DashboardSectionsFeed
                breaking={[]}
                rows={rows}
                openedIds={new Set()}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        expect(getByLabelText('header:fact:Statement f1')).toBeTruthy();
        expect(getAllByText(/^card:/)).toHaveLength(3);
        expect(getByText('footer:5')).toBeTruthy();
    });

    it('omits the footer when a section has 3 or fewer groups', () => {
        const rows = [makeRow('f1', [makeGroup('g1', 1000, 1000), makeGroup('g2', 900, 900)])];
        const { queryByLabelText, getAllByText } = render(
            <DashboardSectionsFeed
                breaking={[]}
                rows={rows}
                openedIds={new Set()}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        expect(getAllByText(/^card:/)).toHaveLength(2);
        expect(queryByLabelText('footer')).toBeNull();
    });

    it('navigates to the fact feed when the header is pressed', () => {
        const rows = [makeRow('f1', [makeGroup('g1', 1000, 1000)])];
        const { getByLabelText } = render(
            <DashboardSectionsFeed
                breaking={[]}
                rows={rows}
                openedIds={new Set()}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        fireEvent.press(getByLabelText('header:fact:Statement f1'));
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/logged-in/fact-feed',
            params: { factId: 'f1', statement: 'Statement f1' },
        });
    });

    it('navigates to the fact feed when the footer is pressed', () => {
        const groups = [
            makeGroup('g1', 5000, 5000),
            makeGroup('g2', 4000, 4000),
            makeGroup('g3', 3000, 3000),
            makeGroup('g4', 2000, 2000),
        ];
        const { getByLabelText } = render(
            <DashboardSectionsFeed
                breaking={[]}
                rows={[makeRow('f1', groups)]}
                openedIds={new Set()}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        fireEvent.press(getByLabelText('footer'));
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/logged-in/fact-feed',
            params: { factId: 'f1', statement: 'Statement f1' },
        });
    });

    it('renders a provisional row with a non-navigable header, all cards inline, and no footer', () => {
        const groups = [
            makeGroup('g1', 5000, 5000),
            makeGroup('g2', 4000, 4000),
            makeGroup('g3', 3000, 3000),
            makeGroup('g4', 2000, 2000),
        ];
        const row: FactRow = {
            ...makeRow('provisional', groups),
            kind: 'provisional',
            factId: 'provisional',
            statement: 'provisional',
        };
        const { getByLabelText, getAllByText, queryByLabelText } = render(
            <DashboardSectionsFeed
                breaking={[]}
                rows={[row]}
                openedIds={new Set()}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        // Header renders as the STATIC (non-navigable) variant — not a pressable
        // navigation header.
        expect(getByLabelText('statichdr:provisional:provisional')).toBeTruthy();
        expect(queryByLabelText('header:provisional:provisional')).toBeNull();
        // All 4 cards render inline (no 3-preview cap) and there is NO footer
        // (which would navigate into a non-existent fact feed).
        expect(getAllByText(/^card:/)).toHaveLength(4);
        expect(queryByLabelText('footer')).toBeNull();
        expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it('flows the new-since-last-visit count into the header badge', () => {
        // Last visited at t=1500 → groups added after that are "new" (g1,g2,g3).
        mockVisits = { f1: 1500 };
        const groups = [
            makeGroup('g1', 5000, 5000),
            makeGroup('g2', 4000, 4000),
            makeGroup('g3', 3000, 3000),
            makeGroup('g4', 1000, 1000),
            makeGroup('g5', 900, 900),
        ];
        const { getByText } = render(
            <DashboardSectionsFeed
                breaking={[]}
                rows={[makeRow('f1', groups)]}
                openedIds={new Set()}
                onPressSuggestion={jest.fn()}
                scrollHandler={noopHandler}
                headerHeight={100}
            />,
        );
        expect(getByText('new:3')).toBeTruthy();
    });
});
