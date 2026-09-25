/* eslint-disable @typescript-eslint/no-require-imports */
// HeaderIconButton with REAL icon-font glyphs (the other suite draws icons as
// Views). A glyph inside a button surfaced on iOS as its own StaticText,
// hidden props or not (captured, ux2), so no private-use Text may sit under an
// accessible element, and each must be hidden itself.

import { render } from '@testing-library/react-native';
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
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import HeaderIconButton from '../HeaderIconButton';

const PUA = /[\uE000-\uF8FF]/;

it('exposes no private-use StaticText anywhere in the tree', () => {
    const r = render(<HeaderIconButton icon="search" onPress={jest.fn()} accessibilityLabel="Search" testID="b" />);
    const glyphs = r.UNSAFE_root.findAll(
        (n: any) => typeof n.type === 'string' && PUA.test(String(n.props?.children ?? '')),
    );
    // Presence first, so the loop below is not vacuous.
    expect(glyphs.length).toBeGreaterThan(0);
    for (const g of glyphs) {
        expect(g.props.accessible).toBe(false);
        expect(g.props.accessibilityElementsHidden).toBe(true);
        expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
        for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
    }
});
