/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import type { ExploreScope } from '@/lib/explore/scopes';

// Stub the css-interop JSX wrapper layer (reads Platform.OS at module load,
// undefined under jest-expo) — same shim the other component tests use.
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

// Render FlatList as a plain fragment of its items. jest-expo mis-transforms
// RN's internal horizontal-ScrollView native-component file, so rendering a real
// FlatList throws "Unexpected token 'export'". A Proxy over the actual module
// keeps every other RN export lazy (our ui mocks read View/Text/Pressable).
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'FlatList') {
                return ({ data, renderItem, keyExtractor }: any) =>
                    ReactLib.createElement(
                        ReactLib.Fragment,
                        null,
                        (data ?? []).map((item: any, index: number) =>
                            ReactLib.createElement(
                                ReactLib.Fragment,
                                { key: keyExtractor ? keyExtractor(item, index) : index },
                                renderItem({ item, index }),
                            ),
                        ),
                    );
            }
            return (target as any)[prop];
        },
    });
});

jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View {...props} /> };
});

import ScopeChipRow from '../ScopeChipRow';

// Mirrors the real order: countries first, World always last. (The city scope
// is a DEPRECATED kind kept only for already-persisted selection ids; it is
// included here because ScopeChipRow still has to render one if it appears.)
const scopes: ExploreScope[] = [
    { id: 'country:FRA', kind: 'country', label: 'France', icon: 'flag', flagEmoji: '🇫🇷', countryCodeAlpha3: 'FRA' },
    { id: 'country:IND', kind: 'country', label: 'India', icon: 'flag', flagEmoji: '🇮🇳', countryCodeAlpha3: 'IND' },
    { id: 'city:IND:mumbai', kind: 'city', label: 'Mumbai', icon: 'location-city', countryCodeAlpha3: 'IND', city: 'mumbai' },
    { id: 'world', kind: 'world', label: '', icon: 'public', countryCodeAlpha3: null },
];

describe('ScopeChipRow', () => {
    beforeEach(() => {
        mockRouterPush.mockClear();
    });

    it('renders a chip per scope (World uses the translated label key, the rest their own label)', () => {
        const { getByText, queryByText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={jest.fn()} onRemove={jest.fn()} />,
        );
        expect(getByText('explore.scopeWorld')).toBeTruthy();
        expect(getByText('France')).toBeTruthy();
        expect(getByText('India')).toBeTruthy();
        expect(getByText('Mumbai')).toBeTruthy();
        // The Top stories chip was deleted outright (geo-derivation wave).
        expect(queryByText('explore.scopeTopStories')).toBeNull();
    });

    it('fires onSelect with the tapped scope', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={onSelect} onRemove={jest.fn()} />,
        );
        fireEvent.press(getByText('Mumbai'));
        expect(onSelect).toHaveBeenCalledWith(scopes[2]);
    });

    it('marks the selected chip via accessibilityState', () => {
        const { getByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="country:IND" onSelect={jest.fn()} onRemove={jest.fn()} />,
        );
        expect(getByLabelText('India').props.accessibilityState).toMatchObject({ selected: true });
    });

    it('renders a trailing "+" chip after the last scope', () => {
        const { getByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={jest.fn()} onRemove={jest.fn()} />,
        );
        expect(getByLabelText('explore.addSources')).toBeTruthy();
    });

    it('the "+" chip is never marked selected and navigates to the Sources screen on tap, without firing onSelect', () => {
        const onSelect = jest.fn();
        const { getByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={onSelect} onRemove={jest.fn()} />,
        );
        const addChip = getByLabelText('explore.addSources');
        expect(addChip.props.accessibilityState).not.toMatchObject({ selected: true });

        fireEvent.press(addChip);
        expect(mockRouterPush).toHaveBeenCalledWith('/logged-in/sources');
        expect(onSelect).not.toHaveBeenCalled();
    });
});

describe('ScopeChipRow — long-press to reveal "×" (Item 18)', () => {
    it('long-pressing a country chip reveals a "×" that calls onRemove with that scope', () => {
        const onRemove = jest.fn();
        const { getByText, getByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={jest.fn()} onRemove={onRemove} />,
        );
        fireEvent(getByText('India'), 'longPress');
        const removeButton = getByLabelText('explore.removeScope');
        fireEvent.press(removeButton);
        expect(onRemove).toHaveBeenCalledWith(scopes[1]);
    });

    it('the "×" is not rendered before a long-press', () => {
        const { queryByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={jest.fn()} onRemove={jest.fn()} />,
        );
        expect(queryByLabelText('explore.removeScope')).toBeNull();
    });

    it('World is never hideable — long-pressing it reveals no "×"', () => {
        const { getByText, queryByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={jest.fn()} onRemove={jest.fn()} />,
        );
        fireEvent(getByText('explore.scopeWorld'), 'longPress');
        expect(queryByLabelText('explore.removeScope')).toBeNull();
    });

    it('tapping the chip to select dismisses a revealed "×" without firing onRemove', () => {
        const onSelect = jest.fn();
        const onRemove = jest.fn();
        const { getByText, queryByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={onSelect} onRemove={onRemove} />,
        );
        fireEvent(getByText('India'), 'longPress');
        expect(queryByLabelText('explore.removeScope')).toBeTruthy();

        fireEvent.press(getByText('India'));
        expect(onSelect).toHaveBeenCalledWith(scopes[1]);
        expect(onRemove).not.toHaveBeenCalled();
        expect(queryByLabelText('explore.removeScope')).toBeNull();
    });

    it('long-pressing a different chip moves the "×" instead of stacking two', () => {
        const { getByText, getAllByLabelText } = render(
            <ScopeChipRow scopes={scopes} selectedId="world" onSelect={jest.fn()} onRemove={jest.fn()} />,
        );
        fireEvent(getByText('France'), 'longPress');
        fireEvent(getByText('India'), 'longPress');
        expect(getAllByLabelText('explore.removeScope')).toHaveLength(1);
    });
});
