// SourcesL2PublicationList — item 6 (source-kind badges) + item 9 (L2
// publisher-level ↑/↓ preference control), Wave B.
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
    useTranslation: () => ({ t: (key: string, o?: any) => o?.defaultValue ?? key }),
}));

// jest-expo mis-transforms RN's ScrollView; FlatList's VirtualizedList tree is
// brittle under the test renderer — proxy both to plain renderers, same trick
// as SourcesL1CountryList.test.tsx.
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
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('lucide-react-native', () => ({ ChevronDownIcon: () => null }));

// Accordion primitives collapse to plain Views that always render their
// children — this suite only cares about what's IN the header/content, not
// gluestack's real expand/collapse animation.
jest.mock('@/components/ui/accordion', () => {
    const { View, Text } = require('react-native');
    return {
        Accordion: (p: any) => <View {...p} />,
        AccordionItem: (p: any) => <View {...p} />,
        AccordionHeader: (p: any) => <View {...p} />,
        AccordionTrigger: (p: any) => <View {...p} />,
        AccordionTitleText: (p: any) => <Text {...p} />,
        AccordionIcon: (p: any) => <View {...p} />,
        AccordionContent: (p: any) => <View {...p} />,
    };
});

jest.mock('@/components/custom/config-panel/DrillDownHeader', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ title, onBack }: any) => (
            <View>
                <Pressable accessibilityLabel="drilldown-back" onPress={onBack} />
                <Text>{title}</Text>
            </View>
        ),
    };
});

// Same pre-existing gap fixed in PublicationPreferencesScreen.test.tsx — this
// screen also imports the free-tier gate, whose own import chain opens the
// real WatermelonDB adapter unless mocked.
jest.mock('@/components/custom/subscription/FreeTierReadOnlyBanner', () => ({
    __esModule: true,
    default: () => null,
    useFreeTierReadOnly: () => mockReadOnly(),
}));
const mockReadOnly = jest.fn(() => false);

const mockGetNewsPublishers = jest.fn();
jest.mock('@/lib/source-service', () => ({
    SourceService: { getNewsPublishers: (...a: unknown[]) => mockGetNewsPublishers(...a) },
}));

let observedPrefRows: any[] = [];
const mockObserveActivePrefs = jest.fn(() => ({
    subscribe: (cb: (rows: any[]) => void) => {
        cb(observedPrefRows);
        return { unsubscribe: jest.fn() };
    },
}));
jest.mock('@/lib/database/services/publication-preference-service', () => ({
    observeActive: () => mockObserveActivePrefs(),
}));

const mockSetSourcePrefFromUi = jest.fn(async (..._a: unknown[]) => ({ applied: true }));
jest.mock('@/lib/database/services/publication-pref-ui-actions', () => ({
    setSourcePrefFromUi: (...a: unknown[]) => mockSetSourcePrefFromUi(...a),
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...args: any[]) => mockRouterPush(...args) } }));

import SourcesL2PublisherList from '../SourcesL2PublicationList';

function makeSource(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'src-1',
        publication_name: 'The Times',
        category: 'general_news',
        publication_type: null,
        categories: [],
        ...overrides,
    };
}

function makePublisher(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'pub-1',
        name: 'The Times',
        website_url: 'https://thetimes.example',
        country_code: 'IN',
        publicationSources: [makeSource()],
        ...overrides,
    };
}

function mockPublishers(newsPublishers: any[]) {
    mockGetNewsPublishers.mockResolvedValue({
        newsPublishers,
        pageInfo: { endCursor: null, hasNextPage: false, pageSize: 5 },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockReadOnly.mockReturnValue(false);
    observedPrefRows = [];
});

describe('item 6 — source-kind badges', () => {
    it('renders NOTHING for a null publication_type (the current prod state for all rows)', async () => {
        mockPublishers([makePublisher({ publicationSources: [makeSource({ publication_type: null })] })]);
        const { queryByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        await waitFor(() => expect(mockGetNewsPublishers).toHaveBeenCalled());
        expect(queryByText('Government source')).toBeNull();
        expect(queryByText('Official agency')).toBeNull();
    });

    it('renders NOTHING for an unrecognized publication_type (e.g. "newspaper")', async () => {
        mockPublishers([makePublisher({ publicationSources: [makeSource({ publication_type: 'newspaper' })] })]);
        const { queryByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        await waitFor(() => expect(mockGetNewsPublishers).toHaveBeenCalled());
        expect(queryByText('Government source')).toBeNull();
        expect(queryByText('Official agency')).toBeNull();
    });

    it('badges the feed row "Government source" for publication_type "government"', async () => {
        // A single-source publisher trivially "agrees with itself", so the
        // header badges too — 2 matches (header + the one feed row).
        mockPublishers([makePublisher({ publicationSources: [makeSource({ publication_type: 'government' })] })]);
        const { findAllByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        expect((await findAllByText('Government source')).length).toBe(2);
    });

    it('badges the feed row "Official agency" for publication_type "regulator"', async () => {
        mockPublishers([makePublisher({ publicationSources: [makeSource({ publication_type: 'regulator' })] })]);
        const { findAllByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        expect((await findAllByText('Official agency')).length).toBe(2);
    });

    it('badges the PUBLISHER HEADER too when every one of its sources agrees', async () => {
        mockPublishers([
            makePublisher({
                publicationSources: [
                    makeSource({ _id: 's1', publication_type: 'government' }),
                    makeSource({ _id: 's2', publication_type: 'government', category: 'politics' }),
                ],
            }),
        ]);
        const { findAllByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        // One on the header, one per matching feed row (2 sources here) = 3.
        const matches = await findAllByText('Government source');
        expect(matches.length).toBe(3);
    });

    it('does NOT badge the header when sources disagree, even though each row badges individually', async () => {
        mockPublishers([
            makePublisher({
                publicationSources: [
                    makeSource({ _id: 's1', publication_type: 'government' }),
                    makeSource({ _id: 's2', publication_type: 'regulator', category: 'politics' }),
                ],
            }),
        ]);
        const { findByText, queryAllByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        // Both per-row badges still render...
        expect(await findByText('Government source')).toBeTruthy();
        expect(await findByText('Official agency')).toBeTruthy();
        // ...but only ONE of each — none of the extra copy a header badge
        // would add.
        expect(queryAllByText('Government source').length).toBe(1);
        expect(queryAllByText('Official agency').length).toBe(1);
    });

    it('the categories line no longer folds in publication_type (no merged "Government · Politics" text)', async () => {
        mockPublishers([
            makePublisher({
                publicationSources: [makeSource({ publication_type: 'government', categories: ['politics'] })],
            }),
        ]);
        const { findAllByText, findByText, queryByText } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        // The badge still renders (header + row, single agreeing source)...
        expect((await findAllByText('Government source')).length).toBe(2);
        // ...but `categories` renders on its own, un-merged with the badge text.
        expect(await findByText('Politics')).toBeTruthy();
        expect(queryByText('Government · Politics')).toBeNull();
        expect(queryByText(/Government source.*Politics|Politics.*Government source/)).toBeNull();
    });
});

describe('item 9 — L2 publisher-level ↑/↓ control', () => {
    it('reflects the live publication_preferences state (boost → "prioritised")', async () => {
        observedPrefRows = [{ publicationName: 'The Times', weight: 0.5, scopeKind: null }];
        mockPublishers([makePublisher({ name: 'The Times' })]);
        const { findByTestId } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        const upButton = await findByTestId('source-pref-publisher-pub-1-up');
        expect(upButton.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    });

    it('a scope row (scopeKind set) is never mistaken for a publication match', async () => {
        observedPrefRows = [{ publicationName: 'The Times', weight: 0.5, scopeKind: 'country', scopeValue: 'IND' }];
        mockPublishers([makePublisher({ name: 'The Times' })]);
        const { findByTestId } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        const upButton = await findByTestId('source-pref-publisher-pub-1-up');
        expect(upButton.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    });

    it('tapping ↑ calls setSourcePrefFromUi with a publication target keyed on the publisher name', async () => {
        mockPublishers([makePublisher({ _id: 'pub-9', name: 'The Herald' })]);
        const { findByTestId } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        const upButton = await findByTestId('source-pref-publisher-pub-9-up');
        await act(async () => {
            fireEvent.press(upButton);
        });
        expect(mockSetSourcePrefFromUi).toHaveBeenCalledWith(
            { kind: 'publication', publicationName: 'The Herald' },
            'prioritised',
        );
    });

    it('free-tier read-only disables the control', async () => {
        mockReadOnly.mockReturnValue(true);
        mockPublishers([makePublisher()]);
        const { findByTestId } = render(
            <SourcesL2PublisherList countryCode="IND" countryName="India" onBack={jest.fn()} />,
        );
        const upButton = await findByTestId('source-pref-publisher-pub-1-up');
        expect(upButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    });
});
