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

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
// As on device: InputSlot IS a Pressable (accessible), and InputField is an
// accessible TextInput whose label defaults to "Input Field".
jest.mock('@/components/ui/input', () => {
    const { View, TextInput, Pressable } = require('react-native');
    return {
        Input: (p: any) => <View {...p} />,
        InputField: ({ 'aria-label': aria = 'Input Field', ...p }: any) => (
            <TextInput accessible accessibilityLabel={aria} {...p} />
        ),
        InputSlot: (p: any) => <Pressable accessible {...p} />,
    };
});
// Real icon-font glyphs, so a glyph under an accessible element is caught.
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import ExploreSearchBar from '../ExploreSearchBar';

describe('ExploreSearchBar', () => {
    it('renders the wrapper testID (InputField swallows its own)', () => {
        const { getByTestId } = render(
            <ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        expect(getByTestId('explore-search-input')).toBeTruthy();
    });

    it('shows the placeholder and current query value', () => {
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="modi india" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        const input = getByPlaceholderText('explore.searchPlaceholder');
        expect(input.props.value).toBe('modi india');
    });

    it('calls onChangeQuery as the user types', () => {
        const onChangeQuery = jest.fn();
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="" onChangeQuery={onChangeQuery} onClose={jest.fn()} />,
        );
        fireEvent.changeText(getByPlaceholderText('explore.searchPlaceholder'), 'india');
        expect(onChangeQuery).toHaveBeenCalledWith('india');
    });

    it('autofocuses, so the tap that revealed it also raises the keyboard', () => {
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        expect(getByPlaceholderText('explore.searchPlaceholder').props.autoFocus).toBe(true);
    });

    it('shows the close control even with an EMPTY query — it is the only way back', () => {
        const { getByTestId } = render(
            <ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        expect(getByTestId('explore-search-close')).toBeTruthy();
    });

    it('calls onClose when the ✕ is pressed', () => {
        const onClose = jest.fn();
        const { getByTestId } = render(
            <ExploreSearchBar query="india" onChangeQuery={jest.fn()} onClose={onClose} />,
        );
        fireEvent.press(getByTestId('explore-search-close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    // Captured (ux2 batch 27): with the bar open, the search glyph was its own
    // StaticText and part of a container label (", Input Field, Close search"),
    // and Close search measured 18x18.
    it('exposes no private-use StaticText anywhere', () => {
        const r = render(<ExploreSearchBar query="india" onChangeQuery={jest.fn()} onClose={jest.fn()} />);
        const glyphs = r.UNSAFE_root.findAll(
            (n: any) => typeof n.type === 'string' && /[\uE000-\uF8FF]/.test(String(n.props?.children ?? '')),
        );
        expect(glyphs.length).toBe(2);
        for (const g of glyphs) {
            expect(g.props.accessible).toBe(false);
            expect(g.props.accessibilityElementsHidden).toBe(true);
            expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
            for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
        }
    });

    it('makes Close search a childless labelled 44x44 numeric frame', () => {
        const { StyleSheet } = require('react-native');
        const { getByTestId } = render(<ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />);
        const close = getByTestId('explore-search-close');
        expect(close.props.accessibilityLabel).toBe('explore.closeSearch');
        expect(close.props.accessibilityRole).toBe('button');
        const flat = StyleSheet.flatten(close.props.style);
        expect(flat.width).toBe(44);
        expect(flat.height).toBe(44);
        expect(close.findAll((n: any) => n !== close && typeof n.type === 'string' && n.type !== 'View')).toHaveLength(0);
    });

    it('keeps the input focusable and labelled with its placeholder, not "Input Field"', () => {
        const { getByPlaceholderText } = render(<ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />);
        const input = getByPlaceholderText('explore.searchPlaceholder');
        expect(input.props.accessible).toBe(true);
        expect(input.props.accessibilityLabel).toBe('explore.searchPlaceholder');
    });
});
