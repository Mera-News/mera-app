/**
 * The indeterminate bar: a segment sweeping an EXPLICIT-width track forever,
 * and a still segment when the OS Reduce Motion setting is on. The bar is
 * decorative (hidden from VoiceOver), so every query needs includeHiddenElements.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

let mockReduceMotion = false;
const mockWithRepeat = jest.fn((v: unknown) => v);

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const R = require('react');
    return {
        __esModule: true,
        default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
        Easing: { linear: 'linear', inOut: (f: unknown) => f, ease: 'ease' },
        useSharedValue: (initial: number) => {
            const { useRef } = require('react');
            return useRef({ value: initial }).current;
        },
        useAnimatedStyle: (fn: () => unknown) => fn(),
        useReducedMotion: () => mockReduceMotion,
        withRepeat: (...a: unknown[]) => mockWithRepeat(...(a as [unknown])),
        withTiming: (v: unknown) => v,
        cancelAnimation: () => undefined,
    };
});

import IndeterminateBar from '../IndeterminateBar';

beforeEach(() => {
    mockWithRepeat.mockClear();
});

describe('IndeterminateBar', () => {
    it('draws a track of exactly the width it is given', () => {
        mockReduceMotion = false;
        const { getByTestId } = render(<IndeterminateBar width={160} testID="bar" />);
        expect(StyleSheet.flatten(getByTestId('bar', { includeHiddenElements: true }).props.style).width).toBe(160);
    });

    it('sweeps forever with withRepeat when motion is allowed', () => {
        mockReduceMotion = false;
        render(<IndeterminateBar width={160} testID="bar" />);
        expect(mockWithRepeat).toHaveBeenCalled();
        const call = mockWithRepeat.mock.calls[0] as unknown[];
        expect(call[1]).toBe(-1);
    });

    it('holds a still segment under Reduce Motion, and never starts the loop', () => {
        mockReduceMotion = true;
        const { getByTestId } = render(<IndeterminateBar width={160} testID="bar" />);
        expect(mockWithRepeat).not.toHaveBeenCalled();
        const segment = StyleSheet.flatten(getByTestId('bar-segment', { includeHiddenElements: true }).props.style);
        expect(segment.width).toBeGreaterThan(0);
        const tx = (segment.transform ?? []).find((t: any) => 'translateX' in t)?.translateX ?? 0;
        // Inside the track, fully visible.
        expect(tx).toBeGreaterThanOrEqual(0);
        expect(tx + segment.width).toBeLessThanOrEqual(160);
    });
});
