// SourcesL1CountryList — browse-country toggle (Item 7) + publisher search
// (Item 8). UI primitives, icons and services are stubbed to plain RN so the
// FlatList rows are inspectable.
/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
// VirtualizedList tree is brittle under the test renderer. Proxy RN so
// ScrollView → View and FlatList → a trivial map that renders each row.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            if (prop === 'FlatList') {
                return ({ data, renderItem, keyExtractor }: any) =>
                    ReactLib.createElement(
                        actual.View,
                        null,
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

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => { const { View, Text } = require('react-native'); return { Button: (p: any) => <View {...p} />, ButtonText: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/input', () => { const { View, TextInput } = require('react-native'); return { Input: (p: any) => <View {...p} />, InputField: (p: any) => <TextInput {...p} />, InputSlot: (p: any) => <View {...p} /> }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} />, MaterialCommunityIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/config-panel/TopVisitedPublicationsCard', () => { const { View } = require('react-native'); return { __esModule: true, default: (p: any) => <View {...p} /> }; });

// Returned unsorted on purpose — the component must sort countries
// alphabetically (Global pinned to the front).
jest.mock('@/lib/account-service', () => ({
    AccountService: { getAllCountries: jest.fn(() => Promise.resolve(['USA', 'IND'])) },
}));
jest.mock('@/lib/country-utils', () => ({
    getCountryName: (code: string) => code,
    getFlagEmoji: () => '🏳️',
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getTopVisitedPublications: jest.fn(() => Promise.resolve([])),
}));

const mockRouterPush = jest.fn();
const focusEffectCallbacks: Array<() => void | (() => void)> = [];
jest.mock('expo-router', () => {
    const ReactLib = require('react');
    return {
        router: { push: (...args: any[]) => mockRouterPush(...args) },
        // Tie into a real `useEffect(cb, [cb])` — NOT a bare `cb()` call in the
        // render body. The component passes a `useCallback`-memoized, stable
        // callback, so this runs exactly once (on mount), same as the real
        // navigation-focus hook. A bare `cb()` call here re-invokes
        // `loadBrowseCountries` (and its `setState`) on every render, which
        // re-renders, which re-invokes it again — an infinite loop (caught by
        // an earlier version of this mock: 1000+ calls instead of 1).
        useFocusEffect: (cb: () => void | (() => void)) => {
            focusEffectCallbacks.push(cb);
            ReactLib.useEffect(cb, [cb]);
        },
    };
});
// Re-fires every *distinct* registered callback once — simulates a screen
// refocus without re-running the same stable callback N times per N renders.
const runFocusEffects = () => {
    new Set(focusEffectCallbacks).forEach((cb) => cb());
};

let browseStore: string[] = [];
const mockGetBrowseCountries = jest.fn(() => Promise.resolve(browseStore));
const mockAddBrowseCountry = jest.fn((code: string) => {
    if (!browseStore.includes(code)) browseStore = [...browseStore, code];
    return Promise.resolve(browseStore);
});
const mockRemoveBrowseCountry = jest.fn((code: string) => {
    browseStore = browseStore.filter((c) => c !== code);
    return Promise.resolve(browseStore);
});
jest.mock('@/lib/explore/browse-countries', () => ({
    getBrowseCountries: () => mockGetBrowseCountries(),
    addBrowseCountry: (code: string) => mockAddBrowseCountry(code),
    removeBrowseCountry: (code: string) => mockRemoveBrowseCountry(code),
}));

const mockSearchPublishers = jest.fn(
    (
        ..._args: unknown[]
    ): Promise<{
        publishers: any[];
        pageInfo: { endCursor: string | null; hasNextPage: boolean; pageSize: number };
    }> => Promise.resolve({ publishers: [], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 10 } }),
);
jest.mock('@/lib/source-service', () => ({
    __esModule: true,
    default: { searchPublishers: (...a: unknown[]) => mockSearchPublishers(...a) },
}));

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import SourcesL1CountryList from '../SourcesL1CountryList';

describe('SourcesL1CountryList — browse-country toggle (Item 7)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        browseStore = [];
        focusEffectCallbacks.length = 0;
    });

    it('renders a toggle per country row but not for GLOBAL', async () => {
        const { findAllByLabelText, queryAllByLabelText } = render(<SourcesL1CountryList />);
        // IND + USA get the toggle; GLOBAL is skipped → exactly 2.
        const adds = await findAllByLabelText('sources.addToExplore');
        expect(adds).toHaveLength(2);
        expect(queryAllByLabelText('sources.addedToExplore')).toHaveLength(0);
    });

    it('adds the country to the browse set using the alpha-2 code — no location, no persona action', async () => {
        const { findAllByLabelText } = render(<SourcesL1CountryList />);
        const adds = await findAllByLabelText('sources.addToExplore');
        // Order: GLOBAL first, then IND, USA — the first toggle is IND → 'IN'.
        fireEvent.press(adds[0]);
        await waitFor(() => expect(mockAddBrowseCountry).toHaveBeenCalledWith('IN'));
    });

    it('shows a check instead of the add icon for an already-browsed country', async () => {
        browseStore = ['IN'];
        const { findAllByLabelText, queryAllByLabelText } = render(<SourcesL1CountryList />);
        await waitFor(() =>
            expect(queryAllByLabelText('sources.addedToExplore')).toHaveLength(1),
        );
        expect(await findAllByLabelText('sources.addToExplore')).toHaveLength(1);
    });

    it('is a TOGGLE — tapping an already-browsed country removes it', async () => {
        browseStore = ['IN'];
        const { findAllByLabelText } = render(<SourcesL1CountryList />);
        const checks = await findAllByLabelText('sources.addedToExplore');
        fireEvent.press(checks[0]);
        await waitFor(() => expect(mockRemoveBrowseCountry).toHaveBeenCalledWith('IN'));
        expect(mockAddBrowseCountry).not.toHaveBeenCalled();
    });

    it('re-reads the browse set on every focus', async () => {
        render(<SourcesL1CountryList />);
        await waitFor(() => expect(mockGetBrowseCountries).toHaveBeenCalledTimes(1));
        act(() => {
            runFocusEffects();
        });
        await waitFor(() => expect(mockGetBrowseCountries.mock.calls.length).toBeGreaterThan(1));
    });

    it('orders Global first, then countries alphabetically (no pin control)', async () => {
        const { findByText, toJSON, queryByLabelText } = render(<SourcesL1CountryList />);
        // Names come through as the raw codes via the country-utils mock.
        await findByText('Global');
        // Flatten the tree into its ordered string leaves.
        const leaves: string[] = [];
        const walk = (node: any) => {
            if (node == null) return;
            if (typeof node === 'string') { leaves.push(node); return; }
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (node.children) walk(node.children);
        };
        walk(toJSON());
        const order = leaves.filter((s) => ['Global', 'IND', 'USA'].includes(s));
        expect(order).toEqual(['Global', 'IND', 'USA']);
        // The removed pin feature leaves no pin toggle behind.
        expect(queryByLabelText('sources.togglePin')).toBeNull();
    });
});

describe('SourcesL1CountryList — publisher search (Item 8)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        browseStore = [];
        focusEffectCallbacks.length = 0;
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Flushes both the fake-timer debounce AND the microtask queue the
    // resulting promise resolves on — fake timers only control `setTimeout`,
    // not Promise microtasks, so `advanceTimersByTime` alone would fire the
    // debounced call but leave its `.then()` unresolved for this tick.
    const flushDebounceAndSearch = async () => {
        await act(async () => {
            jest.advanceTimersByTime(400); // > the component's 300ms debounce
            await Promise.resolve();
            await Promise.resolve();
        });
    };

    // The initial `AccountService.getAllCountries()` / `getTopVisitedPublications()`
    // load (which gates the loading spinner) resolves on the microtask queue
    // too, and needs the same flush before the search box exists to type into.
    const flushInitialLoad = async () => {
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    };

    it('does not query below the 2-char minimum', async () => {
        const { getByPlaceholderText } = render(<SourcesL1CountryList />);
        await flushInitialLoad();
        const input = getByPlaceholderText('sources.searchCountriesOrPublishers');
        act(() => {
            fireEvent.changeText(input, 'a');
            jest.advanceTimersByTime(1000);
        });
        expect(mockSearchPublishers).not.toHaveBeenCalled();
    });

    it('debounces and queries at 2+ chars', async () => {
        mockSearchPublishers.mockResolvedValueOnce({
            publishers: [
                {
                    _id: 'pub-1',
                    name: 'Times of India',
                    website_url: 'https://timesofindia.indiatimes.com',
                    country_code: 'IND',
                    country_name: 'India',
                    matchingSources: [],
                },
            ],
            pageInfo: { endCursor: null, hasNextPage: false, pageSize: 10 },
        });
        const { getByPlaceholderText, getByText } = render(<SourcesL1CountryList />);
        await flushInitialLoad();
        const input = getByPlaceholderText('sources.searchCountriesOrPublishers');
        act(() => {
            fireEvent.changeText(input, 'Times of India');
        });
        // Not queried yet — still inside the debounce window.
        expect(mockSearchPublishers).not.toHaveBeenCalled();

        await flushDebounceAndSearch();

        expect(mockSearchPublishers).toHaveBeenCalledWith(
            expect.objectContaining({ query: 'Times of India' }),
        );
        expect(getByText('Times of India')).toBeTruthy();
    });

    it('filters out non-matching country rows once a publisher search is active', async () => {
        mockSearchPublishers.mockResolvedValueOnce({
            publishers: [
                {
                    _id: 'pub-1',
                    name: 'Some Publisher',
                    website_url: null,
                    country_code: 'IND',
                    country_name: 'India',
                    matchingSources: [],
                },
            ],
            pageInfo: { endCursor: null, hasNextPage: false, pageSize: 10 },
        });
        const { getByPlaceholderText, getByText, queryByText } = render(<SourcesL1CountryList />);
        await flushInitialLoad();
        const input = getByPlaceholderText('sources.searchCountriesOrPublishers');
        act(() => {
            fireEvent.changeText(input, 'zzzznomatch');
        });

        await flushDebounceAndSearch();

        expect(getByText('Some Publisher')).toBeTruthy();
        // Neither country name matches "zzzznomatch" — both are filtered out,
        // only the publisher hit shows.
        expect(queryByText('USA')).toBeNull();
        expect(queryByText('IND')).toBeNull();
    });
});
