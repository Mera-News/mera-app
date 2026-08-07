import { fireEvent, render } from '@testing-library/react-native';
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
    useTranslation: () => ({ t: (key: string) => key }),
}));

// jest-expo mis-transforms RN's ScrollView native component and FlatList's
// VirtualizedList tree is brittle under the test renderer — same workaround
// as SourcesL1CountryList.test.tsx: proxy FlatList to a trivial row map.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'FlatList') {
                return ({ data, renderItem, keyExtractor, testID }: any) =>
                    ReactLib.createElement(
                        actual.View,
                        { testID },
                        (data ?? []).map((item: any, index: number) =>
                            ReactLib.createElement(
                                ReactLib.Fragment,
                                { key: keyExtractor ? keyExtractor(item) : index },
                                renderItem({ item, index }),
                            ),
                        ),
                    );
            }
            return (target as any)[prop];
        },
    });
});

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: ({ onPress, testID, children }: any) => (
            <Pressable onPress={onPress} testID={testID}>
                {children}
            </Pressable>
        ),
        ButtonText: (p: any) => <Text {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

jest.mock('@/components/custom/cards/ArticleCompactCardBase', () => {
    const { Pressable, Text } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => (
            <Pressable testID={p.testID} onPress={p.onPress}>
                <Text>{p.titleEnglish}</Text>
            </Pressable>
        ),
    };
});

const mockPresentFreeTierPaywall = jest.fn();
jest.mock('@/lib/subscription/present-free-tier-paywall', () => ({
    presentFreeTierPaywall: (...a: unknown[]) => mockPresentFreeTierPaywall(...a),
}));

import ExploreSearchResults from '../ExploreSearchResults';

const makeHit = (id: string, overrides: Record<string, unknown> = {}) => ({
    _id: id,
    title_en: `Headline ${id}`,
    image_url: null,
    publication_name: 'Example Times',
    country_code: 'US',
    pubDate: '2026-08-07T00:00:00.000Z',
    score: 0.9,
    ...overrides,
});

const noop = () => {};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('ExploreSearchResults', () => {
    it('idle (below the 2-char floor) shows the min-length hint, nothing else', () => {
        const { getByTestId, queryByTestId } = render(
            <ExploreSearchResults status="idle" hits={[]} errorKind={null} onPressHit={noop} onRetry={noop} />,
        );
        expect(getByTestId('explore-search-min-length')).toBeTruthy();
        expect(queryByTestId('explore-search-loading')).toBeNull();
        expect(queryByTestId('explore-search-results')).toBeNull();
    });

    it('loading shows a spinner', () => {
        const { getByTestId } = render(
            <ExploreSearchResults status="loading" hits={[]} errorKind={null} onPressHit={noop} onRetry={noop} />,
        );
        expect(getByTestId('explore-search-loading')).toBeTruthy();
    });

    it('success with zero hits shows the gentle empty state, not "no articles found"', () => {
        const { getByTestId, getByText } = render(
            <ExploreSearchResults status="success" hits={[]} errorKind={null} onPressHit={noop} onRetry={noop} />,
        );
        expect(getByTestId('explore-search-empty')).toBeTruthy();
        expect(getByText('explore.searchEmpty')).toBeTruthy();
    });

    it('success with hits renders one row per hit, keyed and testID-tagged by _id', () => {
        const hits = [makeHit('h1'), makeHit('h2')];
        const { getByTestId, getByText } = render(
            <ExploreSearchResults status="success" hits={hits} errorKind={null} onPressHit={noop} onRetry={noop} />,
        );
        expect(getByTestId('explore-search-results')).toBeTruthy();
        expect(getByTestId('explore-search-result-h1')).toBeTruthy();
        expect(getByTestId('explore-search-result-h2')).toBeTruthy();
        expect(getByText('Headline h1')).toBeTruthy();
    });

    it('tapping a result row calls onPressHit with that hit', () => {
        const hits = [makeHit('h1')];
        const onPressHit = jest.fn();
        const { getByTestId } = render(
            <ExploreSearchResults status="success" hits={hits} errorKind={null} onPressHit={onPressHit} onRetry={noop} />,
        );
        fireEvent.press(getByTestId('explore-search-result-h1'));
        expect(onPressHit).toHaveBeenCalledWith(hits[0]);
    });

    it('a generic (unknown) error shows a retry action wired to onRetry', () => {
        const onRetry = jest.fn();
        const { getByTestId, getByText } = render(
            <ExploreSearchResults status="error" hits={[]} errorKind="unknown" onPressHit={noop} onRetry={onRetry} />,
        );
        expect(getByTestId('explore-search-error')).toBeTruthy();
        expect(getByText('explore.searchError')).toBeTruthy();
        fireEvent.press(getByTestId('explore-search-error-action'));
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(mockPresentFreeTierPaywall).not.toHaveBeenCalled();
    });

    it('a not-subscribed error shows the paywall message and opens the paywall instead of retrying', () => {
        const onRetry = jest.fn();
        const { getByTestId, getByText } = render(
            <ExploreSearchResults
                status="error"
                hits={[]}
                errorKind="not-subscribed"
                onPressHit={noop}
                onRetry={onRetry}
            />,
        );
        expect(getByText('explore.searchNotSubscribed')).toBeTruthy();
        expect(getByText('freeTier.seePlans')).toBeTruthy();
        fireEvent.press(getByTestId('explore-search-error-action'));
        expect(mockPresentFreeTierPaywall).toHaveBeenCalledWith('explore-search');
        expect(onRetry).not.toHaveBeenCalled();
    });
});
