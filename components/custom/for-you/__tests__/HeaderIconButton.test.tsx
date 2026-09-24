/* eslint-disable @typescript-eslint/no-require-imports */
// One header icon button for every tab header (owner: the Dashboard bell must
// be "the same size and style as the search icon in Explore"). A real 44pt
// frame pulled back to the 24pt glyph by a -10 margin, white glyph, no chip.

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
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID={`icon-${p.name}`} {...p} /> };
});

import { StyleSheet } from 'react-native';
import HeaderIconButton, { HEADER_ICON_COLOR, HEADER_ICON_GLYPH } from '../HeaderIconButton';

describe('HeaderIconButton', () => {
    it('is a 44pt frame with a 24pt footprint, a white 24pt glyph and no chip', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(
            <HeaderIconButton icon="search" onPress={onPress} accessibilityLabel="Search" testID="b" />,
        );
        const b = getByTestId('b');
        expect(StyleSheet.flatten(b.props.style)).toMatchObject({
            width: 44,
            height: 44,
            margin: -10,
            alignItems: 'center',
            justifyContent: 'center',
        });
        expect(b.props.hitSlop).toBeUndefined();
        expect(b.props.className ?? '').not.toMatch(/border|rounded|bg-/);
        expect(b.props.accessibilityRole).toBe('button');
        expect(b.props.accessibilityLabel).toBe('Search');
        const icon = getByTestId('icon-search');
        expect(icon.props.size).toBe(HEADER_ICON_GLYPH);
        expect(HEADER_ICON_GLYPH).toBe(24);
        expect(icon.props.color).toBe(HEADER_ICON_COLOR);
        expect(HEADER_ICON_COLOR).toBe('#ffffff');
        fireEvent.press(b);
        expect(onPress).toHaveBeenCalledTimes(1);
    });
});
