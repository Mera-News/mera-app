/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: any) => o?.defaultValue ?? k }),
}));

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

import SourcePrefControl from '../SourcePrefControl';

describe('SourcePrefControl', () => {
    it('current="none": tapping ↑ requests "prioritised", tapping ↓ requests "deprioritised"', () => {
        const onChange = jest.fn();
        const { getByTestId } = render(
            <SourcePrefControl current="none" onChange={onChange} testIDPrefix="row-1" />,
        );
        fireEvent.press(getByTestId('row-1-up'));
        expect(onChange).toHaveBeenLastCalledWith('prioritised');
        fireEvent.press(getByTestId('row-1-down'));
        expect(onChange).toHaveBeenLastCalledWith('deprioritised');
    });

    it('current="prioritised": tapping the ACTIVE ↑ again clears to "none" (toggle-off)', () => {
        const onChange = jest.fn();
        const { getByTestId } = render(
            <SourcePrefControl current="prioritised" onChange={onChange} testIDPrefix="row-1" />,
        );
        fireEvent.press(getByTestId('row-1-up'));
        expect(onChange).toHaveBeenCalledWith('none');
    });

    it('current="prioritised": tapping ↓ switches directly to "deprioritised" (not "none")', () => {
        const onChange = jest.fn();
        const { getByTestId } = render(
            <SourcePrefControl current="prioritised" onChange={onChange} testIDPrefix="row-1" />,
        );
        fireEvent.press(getByTestId('row-1-down'));
        expect(onChange).toHaveBeenCalledWith('deprioritised');
    });

    it('current="deprioritised": tapping the ACTIVE ↓ again clears to "none" (toggle-off)', () => {
        const onChange = jest.fn();
        const { getByTestId } = render(
            <SourcePrefControl current="deprioritised" onChange={onChange} testIDPrefix="row-1" />,
        );
        fireEvent.press(getByTestId('row-1-down'));
        expect(onChange).toHaveBeenCalledWith('none');
    });

    it('current="deprioritised": tapping ↑ switches directly to "prioritised"', () => {
        const onChange = jest.fn();
        const { getByTestId } = render(
            <SourcePrefControl current="deprioritised" onChange={onChange} testIDPrefix="row-1" />,
        );
        fireEvent.press(getByTestId('row-1-up'));
        expect(onChange).toHaveBeenCalledWith('prioritised');
    });

    it('busy disables both buttons — no onChange call reaches through', () => {
        const onChange = jest.fn();
        const { getByTestId } = render(
            <SourcePrefControl current="none" busy onChange={onChange} testIDPrefix="row-1" />,
        );
        fireEvent.press(getByTestId('row-1-up'));
        fireEvent.press(getByTestId('row-1-down'));
        expect(onChange).not.toHaveBeenCalled();
    });
});
