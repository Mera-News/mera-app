// F41: the one header for pushed pages. The back button says what it does.
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// Real icon-font glyphs, so a glyph under an accessible element is caught.
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });

import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';
import { StyleSheet } from 'react-native';
import DrillDownHeader from '../DrillDownHeader';

describe('DrillDownHeader', () => {
    it('labels the back button Back, not the page title', () => {
        const onBack = jest.fn();
        const r = render(<DrillDownHeader title="Display" onBack={onBack} backTestID="back" />);
        const back = r.getByTestId('back');
        expect(back.props.accessibilityLabel).toBe('common.back');
        fireEvent.press(back);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('announces a locked back button as disabled and ignores the press', () => {
        const onBack = jest.fn();
        const r = render(<DrillDownHeader title="Language" onBack={onBack} backTestID="back" backDisabled />);
        expect(r.getByTestId('back').props.accessibilityState).toEqual({ disabled: true });
        fireEvent.press(r.getByTestId('back'));
        expect(onBack).not.toHaveBeenCalled();
    });

    it('renders no back button when the page is a root', () => {
        const r = render(<DrillDownHeader title="Mera Protocol" />);
        expect(r.queryByLabelText('common.back')).toBeNull();
        expect(r.getByText('Mera Protocol')).toBeTruthy();
    });

    // Captured class (ux2): a glyph inside a button surfaces on iOS as its own
    // StaticText, and a hitSlop target measures as its visible box (29pt here).
    it('draws the arrow outside a childless labelled 44pt button, footprint unchanged', () => {
        const r = render(<DrillDownHeader title="Display" onBack={jest.fn()} backTestID="back" />);
        const glyphs = r.UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)));
        expect(glyphs).toHaveLength(1);
        expect(exposedGlyphTexts(r.UNSAFE_root)).toEqual([]);
        const back = r.getByTestId('back');
        expect(back.findAll((n: any) => n !== back && typeof n.type === 'string' && n.type !== 'View')).toHaveLength(0);
        const frame = StyleSheet.flatten(r.getByTestId('back-frame').props.style);
        expect(frame).toMatchObject({ width: 44, height: 44 });
        // The old box was the 22pt glyph + 3.5pt padding a side, pulled 3.5pt left.
        expect(44 + 2 * frame.marginVertical).toBe(29);
        expect(44 + frame.marginLeft + frame.marginRight).toBe(29 - 3.5);
        expect(back.props.hitSlop).toBeUndefined();
    });
});
