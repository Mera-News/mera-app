jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text, numberOfLines }: { text: string; numberOfLines?: number }) => (
      <Text numberOfLines={numberOfLines}>{text}</Text>
    ),
  };
});

// FactChecksPanel — the Dashboard "Fact checks" chip. Pivot P8d's addition:
// `reconcileStoredFactChecks()` runs BEFORE `refresh()`, on both activation
// and pull-to-refresh, so a row nobody is actively watching (the reader left
// the article, or `useFactCheck`'s poll gave up at its ceiling) still has a
// path back to a terminal answer here. Without it this list recreates r14
// P2b's bug ("a completed check was stuck forever") now that the check is
// server-side again.

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

const calls: string[] = [];
const mockReconcile = jest.fn((..._args: unknown[]) => {
    calls.push('reconcile');
    return Promise.resolve();
});
jest.mock('@/lib/fact-check/fact-check-graphql-client', () => ({
    reconcileStoredFactChecks: (...a: unknown[]) => mockReconcile(...a),
}));

const mockRefresh = jest.fn((..._args: unknown[]) => {
    calls.push('refresh');
    return Promise.resolve();
});
const mockRemove = jest.fn((..._args: unknown[]) => Promise.resolve());
let mockItems: Array<{ id: string; status: string }> = [];
jest.mock('@/lib/stores/fact-checks-store', () => ({
    useFactCheckItems: () => mockItems,
    useFactChecksHydrated: () => true,
    useFactChecksRefreshing: () => false,
    useFactChecksStore: (selector: (s: any) => unknown) =>
        selector({ refresh: mockRefresh, remove: mockRemove }),
}));

jest.mock('@/lib/hooks/use-open-article', () => ({
    useOpenArticle: () => jest.fn(),
}));

jest.mock('@/lib/haptics', () => ({
    hapticLight: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/navigation/tab-bar', () => ({ TAB_BAR_HEIGHT: 0, useTabBarClearance: () => 0 }));

jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: (p: any) => <Text testID={p.testID}>{p.body}</Text> };
});
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/fact-checks/FactCheckCard', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Capture whatever props the panel hands the animated list, WITHOUT actually
// rendering it — `refreshControl` is a plain React element at that point, so
// its `onRefresh` handler is reachable off `.props` with no render needed.
let capturedListProps: any = null;
// It also RENDERS the header and the empty slot: an absence assertion over a
// list mock that drops a slot passes whether the thing is there or not.
jest.mock('react-native-reanimated', () => {
    const ReactLib = require('react');
    const { View } = jest.requireActual('react-native');
    const resolve = (C: any) =>
        ReactLib.isValidElement(C) ? C : typeof C === 'function' ? ReactLib.createElement(C) : null;
    return {
        __esModule: true,
        default: {
            FlatList: (props: any) => {
                capturedListProps = props;
                return ReactLib.createElement(
                    View,
                    null,
                    resolve(props.ListHeaderComponent),
                    props.data?.length ? null : resolve(props.ListEmptyComponent),
                );
            },
        },
        useAnimatedScrollHandler: () => jest.fn(),
    };
});

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/heading', () => {
    const { Text } = require('react-native');
    return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import FactChecksPanel from '../FactChecksPanel';

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('FactChecksPanel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        calls.length = 0;
        capturedListProps = null;
    });

    it('reconciles BEFORE refreshing on activation — a row the sweep advances must already be in the table before the read', async () => {
        render(<FactChecksPanel active />);
        await flush();

        expect(mockReconcile).toHaveBeenCalledTimes(1);
        expect(mockRefresh).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(['reconcile', 'refresh']);
    });

    it('does nothing while inactive — the chip is not selected', async () => {
        render(<FactChecksPanel active={false} />);
        await flush();

        expect(mockReconcile).not.toHaveBeenCalled();
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('pull-to-refresh runs the SAME reconcile-then-refresh sequence, not a bare refresh', async () => {
        render(<FactChecksPanel active />);
        await flush();
        calls.length = 0;
        mockReconcile.mockClear();
        mockRefresh.mockClear();

        expect(capturedListProps?.refreshControl).toBeTruthy();
        await capturedListProps.refreshControl.props.onRefresh();
        await flush();

        expect(calls).toEqual(['reconcile', 'refresh']);
    });

    it('re-runs the sweep when the chip is (re)selected, not just once at mount', async () => {
        const { rerender } = render(<FactChecksPanel active={false} />);
        await flush();
        expect(mockReconcile).not.toHaveBeenCalled();

        rerender(<FactChecksPanel active />);
        await flush();
        expect(mockReconcile).toHaveBeenCalledTimes(1);

        rerender(<FactChecksPanel active={false} />);
        rerender(<FactChecksPanel active />);
        await flush();
        expect(mockReconcile).toHaveBeenCalledTimes(2);
    });
});

describe('FactChecksPanel: header and states', () => {
    const { render: r } = require('@testing-library/react-native');
    const Panel = require('../FactChecksPanel').default;
    afterEach(() => {
        mockItems = [];
    });

    it('draws no second large title under the Dashboard (M3)', () => {
        mockItems = [{ id: 'a', status: 'complete' }];
        const sc = r(<Panel active={false} />);
        // Presence first, so the absence below cannot pass on an empty render.
        expect(sc.getByText('factCheck.dashboard.listSubtitle')).toBeTruthy();
        expect(sc.queryByText('factCheck.dashboard.listTitle')).toBeNull();
    });

    it('uses the shared empty state', () => {
        mockItems = [];
        const sc = r(<Panel active={false} />);
        expect(sc.getByTestId('fact-checks-empty')).toBeTruthy();
    });

    it('shows a checking row while any check is still in flight', () => {
        mockItems = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'complete' }];
        const sc = r(<Panel active={false} />);
        expect(sc.getByTestId('fact-checks-checking-row')).toBeTruthy();
    });

    it('shows no checking row once every check has settled', () => {
        mockItems = [{ id: 'a', status: 'COMPLETE' }, { id: 'b', status: 'blocked' }];
        const sc = r(<Panel active={false} />);
        expect(sc.queryByTestId('fact-checks-checking-row')).toBeNull();
    });
});
