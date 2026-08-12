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
jest.mock('@/lib/stores/fact-checks-store', () => ({
    useFactCheckItems: () => [],
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

jest.mock('@/lib/navigation/tab-bar', () => ({ TAB_BAR_HEIGHT: 0 }));

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
jest.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: {
        FlatList: (props: any) => {
            capturedListProps = props;
            return null;
        },
    },
    useAnimatedScrollHandler: () => jest.fn(),
}));

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
