// SourcesL1CountryList — add-to-locations "+" behavior. UI primitives, icons
// and services are stubbed to plain RN so the FlatList rows are inspectable.
/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
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

const mockAddUserLocation = jest.fn((..._a: unknown[]) => Promise.resolve({ location: {}, updated: false }));
jest.mock('@/lib/database/services/location-persona-actions', () => ({
    addUserLocation: (...args: unknown[]) => mockAddUserLocation(...args),
}));

let mockLocationRows: any[] = [];
jest.mock('@/lib/database/services/location-service', () => ({
    observeAll: () => ({
        subscribe: (cb: (rows: any[]) => void) => {
            cb(mockLocationRows);
            return { unsubscribe: jest.fn() };
        },
    }),
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import SourcesL1CountryList from '../SourcesL1CountryList';

describe('SourcesL1CountryList — add to locations', () => {
    beforeEach(() => {
        mockAddUserLocation.mockClear();
        mockLocationRows = [];
    });

    it('renders a "+" per country row but not for GLOBAL', async () => {
        const { findAllByLabelText, queryAllByLabelText } = render(<SourcesL1CountryList />);
        // IND + USA get the add button; GLOBAL is skipped → exactly 2.
        const adds = await findAllByLabelText('sources.addToLocations');
        expect(adds).toHaveLength(2);
        expect(queryAllByLabelText('sources.addedToLocations')).toHaveLength(0);
    });

    it('adds the country as an interest location using the alpha-2 code', async () => {
        const { findAllByLabelText } = render(<SourcesL1CountryList />);
        const adds = await findAllByLabelText('sources.addToLocations');
        // Order: GLOBAL first, then IND, USA — the first add button is IND → 'IN'.
        fireEvent.press(adds[0]);
        await waitFor(() => expect(mockAddUserLocation).toHaveBeenCalledTimes(1));
        expect(mockAddUserLocation).toHaveBeenCalledWith(
            expect.objectContaining({
                countryCode: 'IN',
                city: null,
                region: null,
                role: 'interest',
            }),
        );
    });

    it('shows a check instead of "+" for already-added countries', async () => {
        mockLocationRows = [{ role: 'interest', city: null, countryCode: 'IN' }];
        const { findAllByLabelText, queryAllByLabelText } = render(<SourcesL1CountryList />);
        await waitFor(() =>
            expect(queryAllByLabelText('sources.addedToLocations')).toHaveLength(1),
        );
        expect(await findAllByLabelText('sources.addToLocations')).toHaveLength(1);
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
