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

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
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

const P = 'world.search.placeholder';

describe('ExploreSearchBar', () => {
    it('renders the wrapper testID (InputField swallows its own)', () => {
        const { getByTestId } = render(<ExploreSearchBar query="" onChangeQuery={jest.fn()} placeholder={P} />);
        expect(getByTestId('explore-search-input')).toBeTruthy();
    });

    it('shows the placeholder and current query value', () => {
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="modi india" onChangeQuery={jest.fn()} placeholder={P} />,
        );
        expect(getByPlaceholderText(P).props.value).toBe('modi india');
    });

    it('calls onChangeQuery as the user types', () => {
        const onChangeQuery = jest.fn();
        const { getByPlaceholderText } = render(<ExploreSearchBar query="" onChangeQuery={onChangeQuery} placeholder={P} />);
        fireEvent.changeText(getByPlaceholderText(P), 'india');
        expect(onChangeQuery).toHaveBeenCalledWith('india');
    });

    it('autofocuses, so the tap that opened Search also raises the keyboard', () => {
        const { getByPlaceholderText } = render(<ExploreSearchBar query="" onChangeQuery={jest.fn()} placeholder={P} />);
        expect(getByPlaceholderText(P).props.autoFocus).toBe(true);
    });

    it('draws no ✕ of its own: the native clear button empties it', () => {
        const r = render(<ExploreSearchBar query="x" onChangeQuery={jest.fn()} placeholder={P} />);
        expect(r.queryByTestId('explore-search-close')).toBeNull();
        expect(r.getByPlaceholderText(P).props.clearButtonMode).toBe('while-editing');
    });

    it('keeps the input focusable and labelled with its placeholder, not "Input Field"', () => {
        const { getByPlaceholderText } = render(<ExploreSearchBar query="" onChangeQuery={jest.fn()} placeholder={P} />);
        const input = getByPlaceholderText(P);
        expect(input.props.accessible).toBe(true);
        expect(input.props.accessibilityLabel).toBe(P);
    });

    // Captured (ux2 batches 27-28): a glyph inside the Input root was composed
    // into the bar's container labels even when hidden. It is drawn over the
    // Input from its parent, with a spacer holding its width inside.
    it('draws its one glyph hidden and outside the Input root', () => {
        const { exposedGlyphTexts } = require('@/lib/__test-helpers__/icon-glyph-a11y');
        const r = render(<ExploreSearchBar query="india" onChangeQuery={jest.fn()} placeholder={P} />);
        expect(exposedGlyphTexts(r.UNSAFE_root)).toEqual([]);
        const glyphs = r.UNSAFE_root.findAll(
            (n: any) => typeof n.type === 'string' && /[\uE000-\uF8FF]/.test(String(n.props?.children ?? '')),
        );
        expect(glyphs).toHaveLength(1);
        const field = r.getByTestId('explore-search-field');
        expect(field.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)))).toHaveLength(0);
    });
});
