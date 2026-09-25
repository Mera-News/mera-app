/* eslint-disable @typescript-eslint/no-require-imports */
// The shared empty state's icon is decoration beside its text. A glyph that is
// not hidden surfaces on iOS as its own StaticText holding the icon-font
// character (captured, ux2), so it carries the three hidden props.

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
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import ForYouEmptyState from '../ForYouEmptyState';

it.each([false, true])('compact=%s: the icon glyph is hidden and under no accessible element', (compact) => {
    const r = render(<ForYouEmptyState icon="bookmark-border" title="T" body="B" compact={compact} testID="e" />);
    const glyphs = r.UNSAFE_root.findAll(
        (n: any) => typeof n.type === 'string' && /[-]/.test(String(n.props?.children ?? '')),
    );
    expect(glyphs).toHaveLength(1);
    const g = glyphs[0];
    expect(g.props.accessible).toBe(false);
    expect(g.props.accessibilityElementsHidden).toBe(true);
    expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
    for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
});
